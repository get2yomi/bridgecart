import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAdmin, requireRole, requireSection } from "../middleware/auth.js";
import { upload } from "../upload.js";
import { logActivity } from "../activityLog.js";
import { sendShopperEmail } from "../email.js";
import { notifyOwner } from "../ownerNotify.js";

export const qualityInspectionsRouter = Router();
qualityInspectionsRouter.use(requireAdmin);

function actorInfo(req) {
  return { actorId: req.session.adminId, actorName: req.session.adminName };
}

// ---- Photo submission (creates the inspection row if needed) ----

qualityInspectionsRouter.post("/orders/:id/inspection/photos", requireSection("orders"), upload.array("photos", 6), async (req, res) => {
  const orderId = Number(req.params.id);
  const { actorId, actorName } = actorInfo(req);

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "At least one photo is required." });
  }

  const order = await query("SELECT id, quality_inspection_requested FROM orders WHERE id = $1", [orderId]);
  if (order.rowCount === 0) return res.status(404).json({ error: "Order not found." });
  if (!order.rows[0].quality_inspection_requested) {
    return res.status(400).json({ error: "This order did not request a quality inspection." });
  }

  let inspection = await query("SELECT * FROM quality_inspections WHERE order_id = $1", [orderId]);
  if (inspection.rowCount === 0) {
    inspection = await query(
      `INSERT INTO quality_inspections (order_id, status) VALUES ($1, 'pending_photos') RETURNING *`,
      [orderId]
    );
  }
  const inspectionId = inspection.rows[0].id;

  for (const file of req.files) {
    await query(
      `INSERT INTO quality_inspection_photos (inspection_id, file_path) VALUES ($1, $2)`,
      [inspectionId, file.filename]
    );
  }

  const updated = await query(
    `UPDATE quality_inspections SET status = 'pending_approval', submitted_by = $2, submitted_at = now(),
       sla_deadline = now() + interval '24 hours'
     WHERE id = $1 RETURNING *`,
    [inspectionId, actorId]
  );

  await logActivity({
    actorId, actorName, action: "submitted_inspection_photos", targetType: "order", targetId: orderId,
    details: { inspectionId, photoCount: req.files.length }
  });

  await notifyOwner(
    `Quality inspection ready for your approval — Order #${orderId}`,
    `Photos have been submitted for order #${orderId}. Please review and decide within 24 hours (deadline: ${updated.rows[0].sla_deadline}).`
  );

  res.status(201).json({ inspection: updated.rows[0] });
});

qualityInspectionsRouter.get("/orders/:id/inspection", requireSection("orders"), async (req, res) => {
  const orderId = Number(req.params.id);
  const inspection = await query("SELECT * FROM quality_inspections WHERE order_id = $1", [orderId]);
  if (inspection.rowCount === 0) return res.json({ inspection: null, photos: [] });

  const photos = await query(
    "SELECT id, file_path, uploaded_at FROM quality_inspection_photos WHERE inspection_id = $1 ORDER BY uploaded_at ASC",
    [inspection.rows[0].id]
  );
  res.json({ inspection: inspection.rows[0], photos: photos.rows });
});

// ---- Owner-only approve/reject ----

qualityInspectionsRouter.post("/inspections/:id/approve", requireRole("owner"), async (req, res) => {
  const { actorId, actorName } = actorInfo(req);
  const inspectionId = Number(req.params.id);

  const result = await query(
    `UPDATE quality_inspections SET status = 'approved', decided_by = $2, decided_at = now()
     WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
    [inspectionId, actorId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Pending inspection not found." });
  const inspection = result.rows[0];

  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'staff', $2, $3, $4, true)`,
    [inspection.order_id, actorId, actorName, "Quality inspection approved. Your order will proceed to shipping."]
  );
  await logActivity({ actorId, actorName, action: "approved_inspection", targetType: "order", targetId: inspection.order_id, details: { inspectionId } });

  res.json({ inspection });
});

qualityInspectionsRouter.post("/inspections/:id/reject", requireRole("owner"), async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A reason is required to reject an inspection." });
  const { actorId, actorName } = actorInfo(req);
  const inspectionId = Number(req.params.id);

  const result = await query(
    `UPDATE quality_inspections SET status = 'rejected', decided_by = $2, decision_reason = $3, decided_at = now()
     WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
    [inspectionId, actorId, reason.trim()]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Pending inspection not found." });
  const inspection = result.rows[0];

  const order = await query("SELECT shopper_id FROM orders WHERE id = $1", [inspection.order_id]);
  const message = "Our quality control team found an issue with your item during inspection. Our team will follow up shortly with next steps.";
  await sendShopperEmail(order.rows[0].shopper_id, "An update on your order's quality check", message);
  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'staff', $2, $3, $4, true)`,
    [inspection.order_id, actorId, actorName, message]
  );
  await logActivity({ actorId, actorName, action: "rejected_inspection", targetType: "order", targetId: inspection.order_id, details: { inspectionId, reason: reason.trim() } });

  res.json({ inspection });
});

// ---- Overdue SLA dashboard + lazy/on-access reminder ----
// No job scheduler exists yet, so the reminder fires the next time this route is hit after the deadline
// has passed, rather than on a real timer. reminder_sent_at ensures it only fires once per inspection.

qualityInspectionsRouter.get("/inspections/overdue", requireSection("orders"), async (req, res) => {
  const overdue = await query(
    `SELECT * FROM quality_inspections WHERE status = 'pending_approval' AND sla_deadline < now() ORDER BY sla_deadline ASC`
  );

  for (const inspection of overdue.rows) {
    if (inspection.reminder_sent_at) continue;
    await notifyOwner(
      `Overdue: quality inspection approval — Order #${inspection.order_id}`,
      `Order #${inspection.order_id}'s quality inspection has been waiting for your decision since ${inspection.submitted_at}. Please review it as soon as possible.`
    );
    await query("UPDATE quality_inspections SET reminder_sent_at = now() WHERE id = $1", [inspection.id]);
    inspection.reminder_sent_at = new Date().toISOString();
  }

  res.json({ inspections: overdue.rows });
});
