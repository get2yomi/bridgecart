import { Router } from "express";
import crypto from "node:crypto";
import { query, pool } from "../db/pool.js";
import { requireAdmin, requireRole, requireSection, requireAnySection } from "../middleware/auth.js";
import { getAllSettings, setSetting, getSetting, getFreightRates } from "../settings.js";
import { calculateQuote } from "../quote.js";
import { logActivity } from "../activityLog.js";
import { sendShopperEmail } from "../email.js";
import { generateTrackingNumber } from "../trackingNumber.js";
import { getPermissionMap } from "../permissions.js";

// Mirrors payments.js's shopper-facing reference-code format.
function generateReferenceCode() {
  return `NB-PAY-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const DIRECT_ROLES = ["owner", "supervisor"];

function actorInfo(req) {
  return { actorId: req.session.adminId, actorName: req.session.adminName };
}

// ---- Current admin's own effective section access (for dashboard nav hiding) ----

adminRouter.get("/me/permissions", async (req, res) => {
  const { permissions, ownerOverride } = await getPermissionMap(req.session.adminId, req.adminUser.role);
  res.json({ sections: permissions, ownerOverride });
});

// ---- Gated action executors (shared by the direct route and the approval-approve route) ----

async function executeApproveShopper(targetId, { reason, actorId, actorName }) {
  const result = await query(
    `UPDATE shoppers SET verification_status = 'approved', verification_notes = $2, verified_at = now(), verified_by = $3, updated_at = now()
     WHERE id = $1 RETURNING id, email, shopper_code`,
    [targetId, reason || null, actorName || String(actorId)]
  );
  if (result.rowCount === 0) throw new Error("Shopper not found.");
  const shopper = result.rows[0];
  await sendShopperEmail(shopper.id, "Your NaijaBridge account is approved", "Your identity has been verified. You can now submit orders.");
  await logActivity({ actorId, actorName, action: "approved_shopper", targetType: "shopper", targetId, details: { reason } });
  return shopper;
}

async function executeRejectShopper(targetId, { reason, actorId, actorName }) {
  const result = await query(
    `UPDATE shoppers SET verification_status = 'rejected', verification_notes = $2, verified_at = now(), verified_by = $3, updated_at = now()
     WHERE id = $1 RETURNING id, email, shopper_code`,
    [targetId, reason || null, actorName || String(actorId)]
  );
  if (result.rowCount === 0) throw new Error("Shopper not found.");
  const shopper = result.rows[0];
  await sendShopperEmail(shopper.id, "Your NaijaBridge registration was not approved", reason || "Please contact support for details.");
  await logActivity({ actorId, actorName, action: "rejected_shopper", targetType: "shopper", targetId, details: { reason } });
  return shopper;
}

async function executeRejectOrder(targetId, { reason, actorId, actorName }) {
  const result = await query(
    `UPDATE orders SET status = 'rejected', admin_notes = $2, confirmed_by = $3, confirmed_at = now(), updated_at = now()
     WHERE id = $1 RETURNING id, shopper_id`,
    [targetId, reason || null, actorName || String(actorId)]
  );
  if (result.rowCount === 0) throw new Error("Order not found.");
  const order = result.rows[0];
  await sendShopperEmail(order.shopper_id, "Your order could not be processed", reason || "Please contact support for details.");
  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'staff', $2, $3, $4, true)`,
    [targetId, actorId, actorName, `Order rejected. ${reason || ""}`.trim()]
  );
  await logActivity({ actorId, actorName, action: "rejected_order", targetType: "order", targetId, details: { reason } });
  return order;
}

async function executeIssueRefund(targetId, { reason, amountUsd, actorId, actorName }) {
  const result = await query(
    `UPDATE orders SET refund_status = 'approved', refund_reason = $2, refund_amount_usd = $3, updated_at = now()
     WHERE id = $1 RETURNING id, shopper_id, refund_status, refund_amount_usd`,
    [targetId, reason || null, amountUsd || null]
  );
  if (result.rowCount === 0) throw new Error("Order not found.");
  const order = result.rows[0];
  await sendShopperEmail(order.shopper_id, "Your refund request was approved", `Your refund request has been approved.${amountUsd ? ` Amount: $${amountUsd}.` : ""} ${reason || ""}`.trim());
  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'staff', $2, $3, $4, true)`,
    [targetId, actorId, actorName, `Refund approved.${amountUsd ? ` Amount: $${amountUsd}.` : ""} ${reason || ""}`.trim()]
  );
  await logActivity({ actorId, actorName, action: "approved_refund", targetType: "order", targetId, details: { reason, amountUsd } });
  return order;
}

// A return, once approved, is handled through the existing refund model rather than a parallel money-flow
// concept — the order enters the same 'refund_status = approved' / 'status = refund_requested' state that
// issue_refund produces, so the existing refund completion step (mark refunded) finishes it either way.
async function executeApproveReturn(targetId, { reason, actorId, actorName, returnRequestId }) {
  const result = await query(
    `UPDATE orders SET refund_status = 'approved', refund_reason = $2, status = 'refund_requested', updated_at = now()
     WHERE id = $1 RETURNING id, shopper_id, refund_status, refund_amount_usd`,
    [targetId, reason || null]
  );
  if (result.rowCount === 0) throw new Error("Order not found.");
  const order = result.rows[0];

  if (returnRequestId) {
    await query(
      `UPDATE return_requests SET status = 'approved', decided_by = $2, decision_reason = $3, decided_at = now() WHERE id = $1`,
      [returnRequestId, actorId, reason || null]
    );
  }

  await sendShopperEmail(order.shopper_id, "Your return request was approved", `Your return request for order #${targetId} has been approved. ${reason || ""}`.trim());
  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'staff', $2, $3, $4, true)`,
    [targetId, actorId, actorName, `Return approved. ${reason || ""}`.trim()]
  );
  await logActivity({ actorId, actorName, action: "approved_return", targetType: "order", targetId, details: { reason, returnRequestId } });
  return order;
}

async function executeConfirmPayment(targetId, { actorId, actorName }) {
  const existing = await query("SELECT * FROM payments WHERE id = $1", [targetId]);
  if (existing.rowCount === 0) throw new Error("Payment not found.");
  const wasRejected = existing.rows[0].status === "rejected";

  const payment = await query(
    "UPDATE payments SET status = 'confirmed', decision_reason = NULL, confirmed_by = $2, confirmed_at = now() WHERE id = $1 RETURNING *",
    [targetId, actorName || String(actorId)]
  );
  const row = payment.rows[0];

  if (row.order_id) {
    await query("UPDATE orders SET status = 'paid', updated_at = now() WHERE id = $1", [row.order_id]);
    await query(
      `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
       VALUES ($1, 'staff', $2, $3, $4, true)`,
      [row.order_id, actorId, actorName, wasRejected ? "A previously rejected payment has now been approved." : "Payment confirmed."]
    );
  }
  if (row.subscription_id) {
    await query(
      `UPDATE subscriptions SET status = 'active', current_period_start = CURRENT_DATE,
         current_period_end = CURRENT_DATE + INTERVAL '30 days', updated_at = now()
       WHERE id = $1`,
      [row.subscription_id]
    );
  }
  await sendShopperEmail(
    row.shopper_id,
    "Payment confirmed",
    wasRejected
      ? `Good news — your payment of $${row.amount_usd} (${row.reference_code}) has now been approved after further review.`
      : `We've confirmed your payment of $${row.amount_usd}. Thank you.`
  );
  await logActivity({ actorId, actorName, action: wasRejected ? "approved_rejected_payment" : "confirmed_payment", targetType: "payment", targetId: row.id, details: { amountUsd: row.amount_usd } });

  // Only a normal order-total payment spawns a follow-up charge — never a follow-up charge itself
  // (charge_type would be 'follow_up_charge') or a subscription payment, or infinite charges would result.
  // Also skip it if one already exists for this order (e.g. this payment was rejected, then approved after
  // an earlier confirm already created the follow-up charge) so approving never double-charges the shopper.
  if (row.charge_type === "order_total" && row.order_id) {
    const alreadyCharged = await query(
      "SELECT 1 FROM payments WHERE order_id = $1 AND charge_type = 'follow_up_charge'",
      [row.order_id]
    );
    if (alreadyCharged.rowCount === 0) {
      await createFollowUpCharge(row.order_id, { actorId, actorName });
    }
  }

  return row;
}

const GATED_ACTIONS = {
  approve_shopper: { targetType: "shopper", run: executeApproveShopper },
  reject_shopper: { targetType: "shopper", run: executeRejectShopper },
  reject_order: { targetType: "order", run: executeRejectOrder },
  issue_refund: { targetType: "order", run: executeIssueRefund },
  approve_return: { targetType: "order", run: executeApproveReturn },
  confirm_payment: { targetType: "payment", run: executeConfirmPayment }
};

async function runGatedAction(req, res, actionType, targetId, extra = {}) {
  const { actorId, actorName } = actorInfo(req);
  const isDirect = DIRECT_ROLES.includes(req.session.adminRole);
  const config = GATED_ACTIONS[actionType];

  if (!isDirect) {
    const inserted = await query(
      `INSERT INTO approval_requests (action_type, target_type, target_id, requested_by, reason, payload)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [actionType, config.targetType, targetId, actorId, extra.reason || null, JSON.stringify(extra)]
    );
    await logActivity({
      actorId, actorName, action: `requested_${actionType}`, targetType: config.targetType, targetId,
      details: { approvalRequestId: inserted.rows[0].id, ...extra }
    });
    return res.status(202).json({ message: "Submitted for supervisor approval.", approvalRequestId: inserted.rows[0].id });
  }

  try {
    const result = await config.run(targetId, { ...extra, actorId, actorName });
    return res.json({ [config.targetType]: result });
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
}

// ---- Shopper directory (every registered shopper, independent of verification queue) ----

adminRouter.get("/shopper-directory", requireSection("shoppers"), async (req, res) => {
  const search = (req.query.search || "").trim();
  const status = req.query.status;
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`s.verification_status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    conditions.push(`(
      lower(s.first_name) LIKE $${idx} OR lower(s.last_name) LIKE $${idx} OR lower(s.email) LIKE $${idx}
      OR lower(s.username) LIKE $${idx} OR lower(s.shopper_code) LIKE $${idx} OR s.phone LIKE $${idx}
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query(
    `SELECT s.id, s.first_name, s.last_name, s.email, s.username, s.phone, s.shopper_code,
            s.verification_status, s.created_at, s.city, s.state,
            (SELECT COUNT(*) FROM orders o WHERE o.shopper_id = s.id) AS order_count
     FROM shoppers s
     ${where}
     ORDER BY s.created_at DESC`,
    params
  );
  res.json({ shoppers: result.rows });
});

// ---- Shopper verification ----

adminRouter.get("/shoppers", requireSection("verifications"), async (req, res) => {
  const status = req.query.status;
  const search = (req.query.search || "").trim();
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`verification_status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    conditions.push(`(
      lower(first_name) LIKE $${idx} OR lower(last_name) LIKE $${idx} OR lower(email) LIKE $${idx}
      OR lower(username) LIKE $${idx} OR lower(shopper_code) LIKE $${idx} OR lower(nin) LIKE $${idx}
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query(`SELECT * FROM shoppers ${where} ORDER BY created_at DESC`, params);
  res.json({ shoppers: result.rows });
});

adminRouter.get("/shoppers/:id", requireAnySection("verifications", "shoppers"), async (req, res) => {
  const shopper = await query("SELECT * FROM shoppers WHERE id = $1", [req.params.id]);
  if (shopper.rowCount === 0) return res.status(404).json({ error: "Shopper not found." });
  const documents = await query("SELECT id, file_path, original_name, mime_type, uploaded_at FROM id_documents WHERE shopper_id = $1", [req.params.id]);
  // LIMIT 1: older shoppers (pre-dating this feature) have no row here — selfie comes back null, handled gracefully by the admin UI.
  const selfie = await query("SELECT id, file_path, mime_type, captured_at FROM selfie_photos WHERE shopper_id = $1 ORDER BY captured_at DESC LIMIT 1", [req.params.id]);
  res.json({ shopper: shopper.rows[0], documents: documents.rows, selfie: selfie.rows[0] || null });
});

adminRouter.get("/shoppers/:id/orders", requireAnySection("verifications", "shoppers"), async (req, res) => {
  const orders = await query(
    `SELECT o.id, o.quote_total_usd, o.status, o.tracking_number, o.created_at,
            COALESCE(items.item_title, 'Untitled item') AS item_title
     FROM orders o
     LEFT JOIN LATERAL (
       SELECT oi.item_title FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.id ASC LIMIT 1
     ) items ON true
     WHERE o.shopper_id = $1 ORDER BY o.created_at DESC`,
    [req.params.id]
  );
  const summary = await query(
    `SELECT COUNT(*) AS order_count,
            COALESCE(SUM(quote_total_usd), 0) AS total_spend_usd,
            COALESCE(SUM(quote_total_usd) FILTER (WHERE status = 'paid' OR status = 'purchased' OR status = 'shipped' OR status = 'delivered'), 0) AS paid_total_usd
     FROM orders WHERE shopper_id = $1`,
    [req.params.id]
  );
  res.json({ orders: orders.rows, summary: summary.rows[0] });
});

adminRouter.post("/shoppers/:id/approve", requireSection("verifications"), (req, res) =>
  runGatedAction(req, res, "approve_shopper", Number(req.params.id), { reason: req.body.notes || null }));

adminRouter.post("/shoppers/:id/reject", requireSection("verifications"), (req, res) =>
  runGatedAction(req, res, "reject_shopper", Number(req.params.id), { reason: req.body.notes || null }));

// A shopper's own actions (shopper_registered, shopper_logged_in, shopper_submitted_order, etc. — see
// activityLog.js callers in auth.js/orders.js/payments.js/accountDashboard.js) are logged with
// actor_type = 'shopper' and actor_id = that shopper's id. Admin actions taken on this shopper are logged
// with target_type = 'shopper' and target_id = this id. Both are relevant to "this shopper's history", so
// they're combined here rather than requiring the UI to make two calls.
adminRouter.get("/shoppers/:id/activity", requireAnySection("verifications", "shoppers"), async (req, res) => {
  const shopperId = Number(req.params.id);
  const result = await query(
    `SELECT * FROM activity_log
     WHERE (target_type = 'shopper' AND target_id = $1)
        OR (actor_type = 'shopper' AND actor_id = $1)
     ORDER BY created_at DESC LIMIT 100`,
    [shopperId]
  );
  res.json({ activity: result.rows });
});

adminRouter.get("/shoppers/:id/messages", requireAnySection("verifications", "shoppers"), async (req, res) => {
  const result = await query(
    "SELECT id, subject, body, sender_type, sender_name, sent_at, read_at, created_at FROM notifications WHERE shopper_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json({ messages: result.rows });
});

adminRouter.post("/shoppers/:id/message", requireSection("verifications"), async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !subject.trim() || !message || !message.trim()) {
    return res.status(400).json({ error: "A subject and message are required." });
  }
  const shopper = await query("SELECT id FROM shoppers WHERE id = $1", [req.params.id]);
  if (shopper.rowCount === 0) return res.status(404).json({ error: "Shopper not found." });

  const { actorId, actorName } = actorInfo(req);
  await sendShopperEmail(req.params.id, subject.trim(), message.trim(), {
    senderType: "admin", senderId: actorId, senderName: actorName
  });
  await logActivity({
    actorId, actorName, action: "messaged_shopper", targetType: "shopper", targetId: Number(req.params.id),
    details: { subject: subject.trim() }
  });
  res.status(201).json({ message: "Message sent." });
});

adminRouter.post("/shoppers/:id/address", requireSection("verifications"), async (req, res) => {
  const { addressLine } = req.body;
  const result = await query(
    "UPDATE shoppers SET us_address_line = $2, updated_at = now() WHERE id = $1 RETURNING id, us_address_line",
    [req.params.id, addressLine || null]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Shopper not found." });
  res.json({ shopper: result.rows[0] });
});

adminRouter.put("/shoppers/:id/shipping-address", requireAnySection("verifications", "shoppers"), async (req, res) => {
  const { streetAddress, city, state } = req.body;
  if (!streetAddress?.trim() || !city?.trim() || !state?.trim()) {
    return res.status(400).json({ error: "Street address, city, and state are all required." });
  }
  const result = await query(
    "UPDATE shoppers SET street_address = $2, city = $3, state = $4, updated_at = now() WHERE id = $1 RETURNING id, street_address, city, state",
    [req.params.id, streetAddress.trim(), city.trim(), state.trim()]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Shopper not found." });
  await logActivity({ ...actorInfo(req), action: "updated_shopper_address", targetType: "shopper", targetId: Number(req.params.id) });
  res.json({ shopper: result.rows[0] });
});

adminRouter.put("/shoppers/:id/physical-address", requireAnySection("verifications", "shoppers"), async (req, res) => {
  const { streetAddress, city, state } = req.body;
  if (!streetAddress?.trim() || !city?.trim() || !state?.trim()) {
    return res.status(400).json({ error: "Street address, city, and state are all required." });
  }
  const result = await query(
    "UPDATE shoppers SET physical_street_address = $2, physical_city = $3, physical_state = $4, updated_at = now() WHERE id = $1 RETURNING id, physical_street_address, physical_city, physical_state",
    [req.params.id, streetAddress.trim(), city.trim(), state.trim()]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Shopper not found." });
  await logActivity({ ...actorInfo(req), action: "updated_shopper_physical_address", targetType: "shopper", targetId: Number(req.params.id) });
  res.json({ shopper: result.rows[0] });
});

// ---- Verification comment history (separate from the approve/reject notes field) ----

adminRouter.get("/shoppers/:id/comments", requireSection("verifications"), async (req, res) => {
  const result = await query(
    "SELECT * FROM shopper_verification_notes WHERE shopper_id = $1 ORDER BY created_at ASC",
    [req.params.id]
  );
  res.json({ comments: result.rows });
});

adminRouter.post("/shoppers/:id/comment", requireSection("verifications"), async (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: "A comment is required." });
  const shopperId = Number(req.params.id);
  const { actorId, actorName } = actorInfo(req);

  const shopper = await query("SELECT id FROM shoppers WHERE id = $1", [shopperId]);
  if (shopper.rowCount === 0) return res.status(404).json({ error: "Shopper not found." });

  const inserted = await query(
    `INSERT INTO shopper_verification_notes (shopper_id, author_id, author_name, note)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [shopperId, actorId, actorName, note.trim()]
  );

  await logActivity({ actorId, actorName, action: "commented_on_shopper", targetType: "shopper", targetId: shopperId, details: { note: note.trim() } });

  res.status(201).json({ comment: inserted.rows[0] });
});

// ---- Orders ----

// Attaches each order's line items (with admin-facing image references — filePath, for building
// /uploads/order-item-images/:filename links the same way the rest of the admin UI already does).
async function attachItemsToOrdersAdmin(orders) {
  if (orders.length === 0) return orders;
  const orderIds = orders.map((o) => o.id);
  const itemsResult = await query(`SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY id ASC`, [orderIds]);
  const itemIds = itemsResult.rows.map((i) => i.id);
  const imagesResult = itemIds.length
    ? await query(`SELECT * FROM order_item_images WHERE order_item_id = ANY($1) ORDER BY id ASC`, [itemIds])
    : { rows: [] };

  const imagesByItem = new Map();
  for (const image of imagesResult.rows) {
    if (!imagesByItem.has(image.order_item_id)) imagesByItem.set(image.order_item_id, []);
    imagesByItem.get(image.order_item_id).push({ id: image.id, filePath: image.file_path });
  }

  const itemsByOrder = new Map();
  for (const item of itemsResult.rows) {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
    itemsByOrder.get(item.order_id).push({ ...item, images: imagesByItem.get(item.id) || [] });
  }

  return orders.map((order) => ({ ...order, items: itemsByOrder.get(order.id) || [] }));
}

// Builds a short display string for an order's items, used anywhere a single "item name" string used to be
// shown (emails, activity log, shipping label) — never crashes on a multi-item order.
function orderItemsSummary(items) {
  if (!items || items.length === 0) return "Untitled item";
  const first = items[0].item_title || "Untitled item";
  if (items.length === 1) return first;
  return `${first} and ${items.length - 1} more item${items.length - 1 === 1 ? "" : "s"}`;
}

adminRouter.get("/orders", requireSection("orders"), async (req, res) => {
  const status = req.query.status;
  const search = (req.query.search || "").trim();
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  }
  if (search) {
    const lowered = `%${search.toLowerCase()}%`;
    params.push(lowered);
    const idx = params.length;
    const asNumber = Number(search);
    const numericClause = Number.isFinite(asNumber) ? `OR o.id = ${Number.isInteger(asNumber) ? asNumber : "-1"}` : "";
    params.push(lowered);
    const itemIdx = params.length;
    conditions.push(`(
      lower(s.first_name) LIKE $${idx} OR lower(s.last_name) LIKE $${idx} OR lower(s.email) LIKE $${idx}
      OR lower(s.shopper_code) LIKE $${idx} OR lower(o.tracking_number) LIKE $${idx}
      ${numericClause}
      OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND lower(oi.item_title) LIKE $${itemIdx})
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query(
    `SELECT o.*, s.first_name, s.last_name, s.shopper_code, s.email FROM orders o JOIN shoppers s ON s.id = o.shopper_id
     ${where} ORDER BY o.created_at DESC`,
    params
  );
  const orders = await attachItemsToOrdersAdmin(result.rows);
  res.json({ orders: orders.map((order) => ({ ...order, item_title: orderItemsSummary(order.items) })) });
});

adminRouter.get("/orders/:id", requireSection("orders"), async (req, res) => {
  const result = await query(
    `SELECT o.*, s.first_name, s.last_name, s.shopper_code, s.email FROM orders o JOIN shoppers s ON s.id = o.shopper_id WHERE o.id = $1`,
    [req.params.id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Order not found." });
  const [order] = await attachItemsToOrdersAdmin(result.rows);
  res.json({ order });
});

// Recalculation contract: the request body carries the full desired item list (each entry optionally
// including an existing order_items `id` when it's an item that already existed and should keep its images;
// an entry with no `id` is treated as a brand-new item). The simplest robust reconciliation — and the one used
// here — is: delete every order_items row for this order whose id is NOT in the surviving id list (this
// cascades to delete that item's images too), then re-insert/update the rest. Concretely:
//   1. Any existing item kept (id present in payload) has its fields UPDATEd in place, so its images survive.
//   2. Any existing item dropped (its id not present in the payload) is DELETEd, cascading its images away.
//   3. Any new item (no id) is INSERTed fresh, with no images (admin can't attach images through this form —
//      only the shopper's original submission or a future admin-upload feature would add them).
// This keeps the contract simple: "the items array you send IS the new set of items," rather than trying to
// diff price/qty/etc changes against images by matching on content.
adminRouter.post("/orders/:id/recalculate", requireSection("orders"), async (req, res) => {
  const { items, speed, taxRate, freeStoreShipping, storeShipping, insurance, qualityInspection } = req.body;
  const orderId = Number(req.params.id);
  const { actorId, actorName } = actorInfo(req);
  const wantsQualityInspection = Boolean(qualityInspection);

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "At least one item is required." });
  }

  const before = await query("SELECT quote_total_usd FROM orders WHERE id = $1", [orderId]);
  if (before.rowCount === 0) return res.status(404).json({ error: "Order not found." });
  const previousTotal = before.rows[0].quote_total_usd;

  let quote;
  try {
    const qualityInspectionFee = wantsQualityInspection ? Number(await getSetting("quality_inspection_fee_usd")) || 0 : 0;
    const freightRates = await getFreightRates();
    quote = calculateQuote({
      items: items.map((item) => ({ price: Number(item.price), quantity: Number(item.quantity), weight: Number(item.weight), category: item.category })),
      speed,
      taxRate: Number(taxRate),
      freeStoreShipping: Boolean(freeStoreShipping),
      storeShipping: Number(storeShipping),
      insurance: Boolean(insurance),
      qualityInspection: wantsQualityInspection,
      qualityInspectionFee,
      freightRates
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");

    const keptIds = items.filter((item) => item.id).map((item) => Number(item.id));
    if (keptIds.length > 0) {
      await client.query("DELETE FROM order_items WHERE order_id = $1 AND id != ALL($2)", [orderId, keptIds]);
    } else {
      await client.query("DELETE FROM order_items WHERE order_id = $1", [orderId]);
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const computed = quote.perItem[i];
      const price = Number(item.price);
      const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
      const weight = Math.max(0.2, Number(item.weight) || 0.2);

      if (item.id) {
        await client.query(
          `UPDATE order_items SET
             product_url = $2, item_title = $3, price_usd = $4, quantity = $5, weight_lb = $6, category = $7,
             color_variant = $8, description = $9, item_subtotal_usd = $10, item_tax_usd = $11, item_duty_usd = $12
           WHERE id = $1 AND order_id = $13`,
          [
            Number(item.id), item.productUrl || null, item.itemTitle || null, price, quantity, weight, item.category,
            item.colorVariant || null, item.description || null, computed.subtotal, computed.tax, computed.duty, orderId
          ]
        );
      } else {
        await client.query(
          `INSERT INTO order_items (
             order_id, product_url, item_title, price_usd, quantity, weight_lb, category, color_variant, description,
             item_subtotal_usd, item_tax_usd, item_duty_usd
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            orderId, item.productUrl || null, item.itemTitle || null, price, quantity, weight, item.category,
            item.colorVariant || null, item.description || null, computed.subtotal, computed.tax, computed.duty
          ]
        );
      }
    }

    const updated = await client.query(
      `UPDATE orders SET shipping_speed = $2, quote_breakdown = $3, quote_total_usd = $4, quality_inspection_requested = $5,
         items_subtotal_usd = $6, items_tax_usd = $7, items_duty_usd = $8, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        orderId, speed, JSON.stringify(quote.breakdown), quote.total, wantsQualityInspection,
        quote.breakdown.itemsSubtotal, quote.breakdown.itemsTax, quote.breakdown.itemsDuty
      ]
    );
    order = updated.rows[0];

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await logActivity({ actorId, actorName, action: "recalculated_order", targetType: "order", targetId: orderId });

  if (Number(previousTotal) !== Number(order.quote_total_usd)) {
    const stalePending = await query(
      "UPDATE payments SET status = 'superseded' WHERE order_id = $1 AND status = 'pending' RETURNING id",
      [orderId]
    );
    if (stalePending.rowCount > 0) {
      const message = `Order price was adjusted to $${order.quote_total_usd} — your previous pending payment has been cancelled. Please submit payment again for the updated amount.`;
      await query(
        `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
         VALUES ($1, 'system', $2, $3, $4, true)`,
        [orderId, actorId, actorName, message]
      );
      await sendShopperEmail(order.shopper_id, "Your order price changed — please pay again", message);
      await logActivity({
        actorId, actorName, action: "superseded_payment", targetType: "order", targetId: orderId,
        details: { oldAmountUsd: previousTotal, newAmountUsd: order.quote_total_usd, supersededPaymentIds: stalePending.rows.map((r) => r.id) }
      });
    }
  }

  const [orderWithItems] = await attachItemsToOrdersAdmin([order]);
  res.json({ order: orderWithItems });
});

adminRouter.post("/orders/:id/confirm", requireSection("orders"), async (req, res) => {
  const trackingNumber = await generateTrackingNumber();
  const result = await query(
    `UPDATE orders SET status = 'confirmed', admin_notes = $2, confirmed_by = $3, confirmed_at = now(),
       tracking_number = COALESCE(tracking_number, $4), updated_at = now()
     WHERE id = $1 RETURNING id, shopper_id, quote_total_usd, tracking_number`,
    [req.params.id, req.body.notes || null, req.session.adminName || String(req.session.adminId), trackingNumber]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Order not found." });
  const order = result.rows[0];
  await sendShopperEmail(order.shopper_id, "Your order is confirmed", `Your order total is confirmed at $${order.quote_total_usd}. Tracking number: ${order.tracking_number}. Please proceed to payment.`);
  await logActivity({ ...actorInfo(req), action: "confirmed_order", targetType: "order", targetId: order.id, details: { trackingNumber: order.tracking_number } });
  res.json({ order });
});

adminRouter.post("/orders/:id/reject", requireSection("orders"), (req, res) =>
  runGatedAction(req, res, "reject_order", Number(req.params.id), { reason: req.body.notes || null }));

adminRouter.post("/orders/:id/status", requireSection("orders"), async (req, res) => {
  const { status } = req.body;
  const orderId = Number(req.params.id);
  const allowed = ["purchased", "shipped", "delivered", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status." });

  if (status === "shipped") {
    const order = await query("SELECT quality_inspection_requested FROM orders WHERE id = $1", [orderId]);
    if (order.rowCount === 0) return res.status(404).json({ error: "Order not found." });
    if (order.rows[0].quality_inspection_requested) {
      const inspection = await query("SELECT status FROM quality_inspections WHERE order_id = $1", [orderId]);
      if (inspection.rowCount === 0 || inspection.rows[0].status !== "approved") {
        return res.status(400).json({ error: "This order requires an approved quality inspection before it can be marked shipped." });
      }
    }
  }

  const result = await query(
    "UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status",
    [orderId, status]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Order not found." });
  await logActivity({ ...actorInfo(req), action: "changed_order_status", targetType: "order", targetId: orderId, details: { status } });
  res.json({ order: result.rows[0] });
});

// ---- Order updates thread ----

adminRouter.get("/orders/:id/updates", requireSection("orders"), async (req, res) => {
  const result = await query(
    "SELECT * FROM order_updates WHERE order_id = $1 ORDER BY created_at ASC",
    [req.params.id]
  );
  res.json({ updates: result.rows });
});

adminRouter.post("/orders/:id/updates", requireSection("orders"), async (req, res) => {
  const { message, visibleToShopper } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "A message is required." });
  const orderId = Number(req.params.id);
  const { actorId, actorName } = actorInfo(req);
  const visible = visibleToShopper !== false;

  const order = await query("SELECT shopper_id FROM orders WHERE id = $1", [orderId]);
  if (order.rowCount === 0) return res.status(404).json({ error: "Order not found." });

  const inserted = await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'staff', $2, $3, $4, $5) RETURNING *`,
    [orderId, actorId, actorName, message.trim(), visible]
  );

  if (visible) {
    await sendShopperEmail(order.rows[0].shopper_id, `Update on your order #${orderId}`, message.trim());
  }
  await logActivity({ actorId, actorName, action: "posted_order_update", targetType: "order", targetId: orderId, details: { visibleToShopper: visible } });

  res.status(201).json({ update: inserted.rows[0] });
});

// ---- Warehouse arrival (reuses the order_updates timeline rather than a new orders.status value) ----

adminRouter.post("/orders/:id/warehouse-received", requireSection("orders"), async (req, res) => {
  const orderId = Number(req.params.id);
  const { actorId, actorName } = actorInfo(req);
  const message = (req.body?.note && req.body.note.trim()) || "Item received at our U.S. warehouse.";

  const order = await query("SELECT shopper_id, warehouse_received_at FROM orders WHERE id = $1", [orderId]);
  if (order.rowCount === 0) return res.status(404).json({ error: "Order not found." });

  // First call stamps the timestamp; later calls just add another timeline note without moving it
  // (handles multi-leg shipments or corrections without losing the original arrival time).
  const updated = await query(
    `UPDATE orders SET warehouse_received_at = COALESCE(warehouse_received_at, now()), updated_at = now()
     WHERE id = $1 RETURNING warehouse_received_at`,
    [orderId]
  );

  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'staff', $2, $3, $4, true)`,
    [orderId, actorId, actorName, message]
  );
  await sendShopperEmail(order.rows[0].shopper_id, `Update on your order #${orderId}`, message);
  await logActivity({ actorId, actorName, action: "marked_warehouse_received", targetType: "order", targetId: orderId, details: { note: message } });

  res.json({ warehouseReceivedAt: updated.rows[0].warehouse_received_at });
});

// ---- Delivery tracking ----

adminRouter.put("/orders/:id/delivery", requireSection("orders"), async (req, res) => {
  const { estimatedDeliveryDate, deliveredDate } = req.body;
  const orderId = Number(req.params.id);
  const { actorId, actorName } = actorInfo(req);

  const existing = await query("SELECT shopper_id, delivered_date FROM orders WHERE id = $1", [orderId]);
  if (existing.rowCount === 0) return res.status(404).json({ error: "Order not found." });
  const wasDelivered = Boolean(existing.rows[0].delivered_date);

  const result = await query(
    `UPDATE orders SET estimated_delivery_date = $2, delivered_date = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [orderId, estimatedDeliveryDate || null, deliveredDate || null]
  );
  const order = result.rows[0];

  const messageParts = [];
  if (estimatedDeliveryDate) messageParts.push(`Estimated delivery date set to ${estimatedDeliveryDate}.`);
  if (deliveredDate) messageParts.push(`Delivered on ${deliveredDate}.`);
  const message = messageParts.join(" ") || "Delivery details updated.";

  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'system', $2, $3, $4, true)`,
    [orderId, actorId, actorName, message]
  );

  if (deliveredDate && !wasDelivered) {
    await sendShopperEmail(order.shopper_id, "Your order has been delivered", `Great news! Your order #${orderId} was delivered on ${deliveredDate}.`);
  } else if (estimatedDeliveryDate) {
    await sendShopperEmail(order.shopper_id, "Delivery estimate updated", `Your order #${orderId} now has an estimated delivery date of ${estimatedDeliveryDate}.`);
  }

  await logActivity({ actorId, actorName, action: "updated_delivery", targetType: "order", targetId: orderId, details: { estimatedDeliveryDate, deliveredDate } });
  res.json({ order });
});

// ---- Refunds ----

adminRouter.post("/orders/:id/refund", requireSection("orders"), async (req, res) => {
  const { action, reason, amountUsd } = req.body;
  const orderId = Number(req.params.id);
  const { actorId, actorName } = actorInfo(req);

  if (!["request", "approve", "deny", "complete"].includes(action)) {
    return res.status(400).json({ error: "Invalid refund action." });
  }

  if (action === "approve") {
    return runGatedAction(req, res, "issue_refund", orderId, { reason: reason || null, amountUsd: amountUsd || null });
  }

  const order = await query("SELECT id, shopper_id FROM orders WHERE id = $1", [orderId]);
  if (order.rowCount === 0) return res.status(404).json({ error: "Order not found." });
  const shopperId = order.rows[0].shopper_id;

  let result;
  let subject;
  let body;

  if (action === "request") {
    result = await query(
      `UPDATE orders SET refund_status = 'requested', refund_reason = $2, status = 'refund_requested', updated_at = now()
       WHERE id = $1 RETURNING *`,
      [orderId, reason || null]
    );
    subject = "Refund request received";
    body = `We've received a refund request for your order #${orderId}. ${reason || ""}`.trim();
  } else if (action === "deny") {
    result = await query(
      `UPDATE orders SET refund_status = 'denied', refund_reason = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [orderId, reason || null]
    );
    subject = "Refund request denied";
    body = `Your refund request for order #${orderId} was denied. ${reason || ""}`.trim();
  } else if (action === "complete") {
    result = await query(
      `UPDATE orders SET refund_status = 'refunded', refund_amount_usd = $2, refund_reason = COALESCE($3, refund_reason), status = 'refunded', updated_at = now()
       WHERE id = $1 RETURNING *`,
      [orderId, amountUsd || null, reason || null]
    );
    subject = "Refund completed";
    body = `Your refund of $${amountUsd || result?.rows[0]?.refund_amount_usd || "0.00"} for order #${orderId} has been completed. ${reason || ""}`.trim();
  }

  await sendShopperEmail(shopperId, subject, body);
  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'staff', $2, $3, $4, true)`,
    [orderId, actorId, actorName, body]
  );
  await logActivity({ actorId, actorName, action: `refund_${action}`, targetType: "order", targetId: orderId, details: { reason, amountUsd } });

  res.json({ order: result.rows[0] });
});

// ---- Returns (gated: only reachable after a failed quality inspection) ----

adminRouter.post("/orders/:id/return-request", requireSection("orders"), async (req, res) => {
  const { itemStillAtOrigin, sellerAcceptsReturn, reason } = req.body;
  const orderId = Number(req.params.id);
  const { actorId, actorName } = actorInfo(req);

  // The real gate. The UI checkboxes are just how staff attest to these facts — there is no seller API to
  // verify them independently, which is inherent to a process-control rule like this one.
  if (itemStillAtOrigin !== true || sellerAcceptsReturn !== true) {
    return res.status(400).json({ error: "A return can only be requested if the item is confirmed still at origin and the seller has accepted the return." });
  }

  const inspection = await query("SELECT id, status FROM quality_inspections WHERE order_id = $1", [orderId]);
  if (inspection.rowCount === 0 || inspection.rows[0].status !== "rejected") {
    return res.status(400).json({ error: "A return can only be requested after a failed quality inspection." });
  }

  const order = await query("SELECT id FROM orders WHERE id = $1", [orderId]);
  if (order.rowCount === 0) return res.status(404).json({ error: "Order not found." });

  const inserted = await query(
    `INSERT INTO return_requests (order_id, inspection_id, requested_by, item_still_at_origin, seller_accepts_return, reason)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [orderId, inspection.rows[0].id, actorId, itemStillAtOrigin, sellerAcceptsReturn, reason || null]
  );

  await logActivity({ actorId, actorName, action: "requested_return", targetType: "order", targetId: orderId, details: { returnRequestId: inserted.rows[0].id, reason } });

  res.status(201).json({ returnRequest: inserted.rows[0] });
});

adminRouter.get("/orders/:id/return-request", requireSection("orders"), async (req, res) => {
  const result = await query("SELECT * FROM return_requests WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1", [req.params.id]);
  res.json({ returnRequest: result.rows[0] || null });
});

adminRouter.post("/return-requests/:id/approve", requireSection("orders"), async (req, res) => {
  const { reason } = req.body;
  const requestId = Number(req.params.id);
  const returnRequest = await query("SELECT * FROM return_requests WHERE id = $1 AND status = 'pending'", [requestId]);
  if (returnRequest.rowCount === 0) return res.status(404).json({ error: "Pending return request not found." });

  return runGatedAction(req, res, "approve_return", returnRequest.rows[0].order_id, { reason: reason || null, returnRequestId: requestId });
});

adminRouter.post("/return-requests/:id/deny", requireSection("orders"), async (req, res) => {
  const { reason } = req.body;
  const { actorId, actorName } = actorInfo(req);
  const requestId = Number(req.params.id);

  const result = await query(
    `UPDATE return_requests SET status = 'denied', decided_by = $2, decision_reason = $3, decided_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [requestId, actorId, reason || null]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Pending return request not found." });
  const returnRequest = result.rows[0];

  await sendShopperEmail(
    (await query("SELECT shopper_id FROM orders WHERE id = $1", [returnRequest.order_id])).rows[0]?.shopper_id,
    "Your return request was denied",
    `Your return request for order #${returnRequest.order_id} was denied. ${reason || ""}`.trim()
  );
  await logActivity({ actorId, actorName, action: "denied_return", targetType: "order", targetId: returnRequest.order_id, details: { returnRequestId: requestId, reason } });

  res.json({ returnRequest });
});

// ---- Approval requests ----

adminRouter.get("/approval-requests", requireSection("approvals"), requireRole("owner", "supervisor"), async (req, res) => {
  // status is absent -> default to 'pending' (back-compat with existing callers); status="" (explicit "All") -> no filter.
  const status = req.query.status === undefined ? "pending" : req.query.status;
  const search = (req.query.search || "").trim();
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`ar.status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    conditions.push(`(
      lower(req.first_name) LIKE $${idx} OR lower(req.last_name) LIKE $${idx} OR lower(ar.action_type) LIKE $${idx}
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query(
    `SELECT ar.*,
            (req.first_name || ' ' || req.last_name) AS requested_by_name, req.email AS requested_by_email,
            (dec.first_name || ' ' || dec.last_name) AS decided_by_name
     FROM approval_requests ar
     LEFT JOIN admin_users req ON req.id = ar.requested_by
     LEFT JOIN admin_users dec ON dec.id = ar.decided_by
     ${where}
     ORDER BY ar.created_at DESC`,
    params
  );

  const requests = [];
  for (const row of result.rows) {
    let target = null;
    if (row.target_type === "shopper") {
      const shopper = await query("SELECT id, first_name, last_name, email, shopper_code FROM shoppers WHERE id = $1", [row.target_id]);
      target = shopper.rows[0] ? { ...shopper.rows[0], full_name: `${shopper.rows[0].first_name} ${shopper.rows[0].last_name}` } : null;
    } else if (row.target_type === "order") {
      const order = await query(
        `SELECT o.id, o.quote_total_usd, o.status, COALESCE(items.item_title, 'Untitled item') AS item_title
         FROM orders o
         LEFT JOIN LATERAL (SELECT oi.item_title FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.id ASC LIMIT 1) items ON true
         WHERE o.id = $1`,
        [row.target_id]
      );
      target = order.rows[0] || null;
    }
    requests.push({ ...row, target });
  }

  res.json({ approvalRequests: requests });
});

adminRouter.post("/approval-requests/:id/approve", requireSection("approvals"), requireRole("owner", "supervisor"), async (req, res) => {
  const { reason } = req.body;
  const { actorId, actorName } = actorInfo(req);
  const requestId = Number(req.params.id);

  const pending = await query("SELECT * FROM approval_requests WHERE id = $1 AND status = 'pending'", [requestId]);
  if (pending.rowCount === 0) return res.status(404).json({ error: "Pending approval request not found." });
  const approvalRequest = pending.rows[0];

  const config = GATED_ACTIONS[approvalRequest.action_type];
  if (!config) return res.status(400).json({ error: "Unknown action type." });

  const extra = approvalRequest.payload ? (typeof approvalRequest.payload === "string" ? JSON.parse(approvalRequest.payload) : approvalRequest.payload) : {};

  let result;
  try {
    result = await config.run(approvalRequest.target_id, { ...extra, actorId, actorName });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const updated = await query(
    `UPDATE approval_requests SET status = 'approved', decided_by = $2, decision_reason = $3, decided_at = now()
     WHERE id = $1 RETURNING *`,
    [requestId, actorId, reason || null]
  );
  await logActivity({
    actorId, actorName, action: "approved_request", targetType: approvalRequest.target_type, targetId: approvalRequest.target_id,
    details: { approvalRequestId: requestId, actionType: approvalRequest.action_type, reason }
  });

  res.json({ approvalRequest: updated.rows[0], result });
});

adminRouter.post("/approval-requests/:id/deny", requireSection("approvals"), requireRole("owner", "supervisor"), async (req, res) => {
  const { reason } = req.body;
  const { actorId, actorName } = actorInfo(req);
  const requestId = Number(req.params.id);

  const result = await query(
    `UPDATE approval_requests SET status = 'denied', decided_by = $2, decision_reason = $3, decided_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [requestId, actorId, reason || null]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Pending approval request not found." });
  const approvalRequest = result.rows[0];

  await logActivity({
    actorId, actorName, action: "denied_request", targetType: approvalRequest.target_type, targetId: approvalRequest.target_id,
    details: { approvalRequestId: requestId, actionType: approvalRequest.action_type, reason }
  });

  res.json({ approvalRequest });
});

// ---- Activity log ----

adminRouter.get("/activity-log", requireSection("activity_log"), async (req, res) => {
  const { actor, action, from, to, actorType, search } = req.query;
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    conditions.push(`(actor_name ILIKE $${idx} OR action ILIKE $${idx})`);
  }
  if (actor) { params.push(`%${actor}%`); conditions.push(`actor_name ILIKE $${params.length}`); }
  if (action) { params.push(`%${action}%`); conditions.push(`action ILIKE $${params.length}`); }
  if (from) { params.push(from); conditions.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`created_at <= $${params.length}`); }
  if (actorType) { params.push(actorType); conditions.push(`actor_type = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const result = await query(
    `SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ${limit}`,
    params
  );
  res.json({ activity: result.rows });
});

// ---- Payments ----

adminRouter.get("/payments", requireSection("payments"), async (req, res) => {
  const status = req.query.status;
  const search = (req.query.search || "").trim();
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    const asInt = Number.isInteger(Number(search)) ? Number(search) : -1;
    conditions.push(`(
      lower(p.reference_code) LIKE $${idx} OR lower(s.first_name) LIKE $${idx} OR lower(s.last_name) LIKE $${idx}
      OR lower(s.email) LIKE $${idx} OR lower(s.shopper_code) LIKE $${idx} OR p.order_id = ${asInt}
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query(
    `SELECT p.*, s.first_name, s.last_name, s.shopper_code, s.email FROM payments p JOIN shoppers s ON s.id = p.shopper_id
     ${where} ORDER BY p.created_at DESC`,
    params
  );
  res.json({ payments: result.rows });
});

function csvCell(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

adminRouter.get("/payments/report.csv", requireSection("payments"), async (req, res) => {
  const shopperId = req.query.shopperId;
  const result = shopperId
    ? await query(
        `SELECT p.*, s.first_name, s.last_name, s.shopper_code, s.email FROM payments p JOIN shoppers s ON s.id = p.shopper_id
         WHERE p.shopper_id = $1 ORDER BY p.created_at DESC`,
        [shopperId]
      )
    : await query(
        `SELECT p.*, s.first_name, s.last_name, s.shopper_code, s.email FROM payments p JOIN shoppers s ON s.id = p.shopper_id
         ORDER BY p.created_at DESC`
      );

  const header = ["Reference code", "Shopper code", "Shopper name", "Email", "Order ID", "Subscription ID", "Charge type", "Method", "Amount (USD)", "Amount (NGN)", "Status", "Created at", "Confirmed by", "Confirmed at", "Reason"];
  const rows = result.rows.map((p) => [
    p.reference_code, p.shopper_code, `${p.first_name} ${p.last_name}`.trim(), p.email,
    p.order_id ?? "", p.subscription_id ?? "", p.charge_type, p.method, p.amount_usd, p.amount_ngn,
    p.status, p.created_at?.toISOString?.() ?? p.created_at, p.confirmed_by ?? "", p.confirmed_at?.toISOString?.() ?? p.confirmed_at ?? "", p.decision_reason ?? ""
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");

  const filenameSuffix = shopperId ? `-shopper-${shopperId}` : "-all";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="naijabridge-payments${filenameSuffix}.csv"`);
  res.send(csv);
});

adminRouter.post("/payments/:id/confirm", requireSection("payments"), (req, res) =>
  runGatedAction(req, res, "confirm_payment", Number(req.params.id)));

async function createFollowUpCharge(orderId, { actorId, actorName }) {
  const order = await query("SELECT shopper_id FROM orders WHERE id = $1", [orderId]);
  if (order.rowCount === 0) return;
  const { shopper_id: shopperId } = order.rows[0];

  // Cost basis is the sum of every item's (price * quantity) in the order — not just one item — since an
  // order can now contain several line items.
  const itemsTotal = await query(
    "SELECT COALESCE(SUM(price_usd * quantity), 0) AS cost_basis FROM order_items WHERE order_id = $1",
    [orderId]
  );
  const costBasis = Number(itemsTotal.rows[0].cost_basis);

  const percent = Number(await getSetting("follow_up_charge_percent")) || 0;
  const exchangeRate = Number(await getSetting("usd_to_ngn_rate")) || 0;
  const amountUsd = Math.round(costBasis * (percent / 100) * 100) / 100;
  if (amountUsd <= 0) return;

  const amountNgn = Math.round(amountUsd * exchangeRate * 100) / 100;
  const referenceCode = generateReferenceCode();

  const inserted = await query(
    `INSERT INTO payments (order_id, shopper_id, method, amount_usd, exchange_rate, amount_ngn, reference_code, status, charge_type)
     VALUES ($1, $2, 'bank_transfer', $3, $4, $5, $6, 'pending', 'follow_up_charge')
     RETURNING *`,
    [orderId, shopperId, amountUsd, exchangeRate, amountNgn, referenceCode]
  );

  const message = `An additional payment of $${amountUsd.toFixed(2)} (${percent}% of item cost) is now due — please check your account to pay.`;
  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'system', $2, $3, $4, true)`,
    [orderId, actorId, actorName, message]
  );
  await sendShopperEmail(shopperId, "An additional payment is due on your order", message);
  await logActivity({
    actorId, actorName, action: "created_follow_up_charge", targetType: "order", targetId: orderId,
    details: { paymentId: inserted.rows[0].id, amountUsd, percent, costBasis }
  });
}

adminRouter.post("/payments/:id/reject", requireSection("payments"), async (req, res) => {
  const reason = (req.body.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "A reason is required to reject a payment." });

  const result = await query(
    "UPDATE payments SET status = 'rejected', decision_reason = $2, confirmed_by = $3, confirmed_at = now() WHERE id = $1 RETURNING *",
    [req.params.id, reason, req.session.adminName || String(req.session.adminId)]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Payment not found." });
  const row = result.rows[0];
  await sendShopperEmail(row.shopper_id, "Your payment could not be confirmed", `Your payment (${row.reference_code}) was not accepted. Reason: ${reason}`);
  if (row.order_id) {
    await query(
      `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
       VALUES ($1, 'staff', $2, $3, $4, true)`,
      [row.order_id, req.session.adminId, req.session.adminName, `Payment rejected: ${reason}`]
    );
  }
  await logActivity({ ...actorInfo(req), action: "rejected_payment", targetType: "payment", targetId: row.id, details: { reason } });
  res.json({ payment: row });
});

adminRouter.post("/payments/:id/reverse", requireRole("owner", "supervisor"), async (req, res) => {
  const reason = (req.body.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "A reason is required to reverse a confirmed payment." });

  const existing = await query("SELECT * FROM payments WHERE id = $1", [req.params.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: "Payment not found." });
  if (existing.rows[0].status !== "confirmed") {
    return res.status(400).json({ error: "Only a confirmed payment can be reversed." });
  }

  const result = await query(
    "UPDATE payments SET status = 'rejected', decision_reason = $2, confirmed_by = $3, confirmed_at = now() WHERE id = $1 RETURNING *",
    [req.params.id, `Reversed: ${reason}`, req.session.adminName || String(req.session.adminId)]
  );
  const row = result.rows[0];

  if (row.order_id) {
    const order = await query("SELECT status FROM orders WHERE id = $1", [row.order_id]);
    if (order.rows[0]?.status === "paid") {
      await query("UPDATE orders SET status = 'awaiting_payment', updated_at = now() WHERE id = $1", [row.order_id]);
    }
    await query(
      `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
       VALUES ($1, 'staff', $2, $3, $4, true)`,
      [row.order_id, req.session.adminId, req.session.adminName, `A previously confirmed payment was reversed: ${reason}`]
    );
  }
  await sendShopperEmail(row.shopper_id, "A payment on your account was reversed", `Your payment (${row.reference_code}) that was previously confirmed has been reversed. Reason: ${reason}. Please contact support if you have questions.`);
  await logActivity({ ...actorInfo(req), action: "reversed_payment", targetType: "payment", targetId: row.id, details: { reason } });
  res.json({ payment: row });
});

adminRouter.put("/payments/:id/comment", requireSection("payments"), async (req, res) => {
  const comment = (req.body.comment || "").trim();
  const result = await query(
    "UPDATE payments SET admin_comment = $2 WHERE id = $1 RETURNING *",
    [req.params.id, comment || null]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Payment not found." });
  await logActivity({ ...actorInfo(req), action: "commented_on_payment", targetType: "payment", targetId: Number(req.params.id), details: { comment } });
  res.json({ payment: result.rows[0] });
});

adminRouter.put("/payments/:id/amount", requireSection("payments"), async (req, res) => {
  const newAmountUsd = Number(req.body.amountUsd);
  if (!Number.isFinite(newAmountUsd) || newAmountUsd <= 0) {
    return res.status(400).json({ error: "A valid payment amount is required." });
  }
  const existing = await query("SELECT * FROM payments WHERE id = $1", [req.params.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: "Payment not found." });
  const payment = existing.rows[0];

  const exchangeRate = Number(payment.exchange_rate);
  const newAmountNgn = Math.round(newAmountUsd * exchangeRate * 100) / 100;
  const result = await query(
    `UPDATE payments SET amount_usd = $2, amount_ngn = $3,
       original_amount_usd = COALESCE(original_amount_usd, $4)
     WHERE id = $1 RETURNING *`,
    [req.params.id, newAmountUsd, newAmountNgn, payment.amount_usd]
  );
  const row = result.rows[0];

  await sendShopperEmail(
    row.shopper_id, "Your payment amount was updated",
    `The amount for your payment (${row.reference_code}) was updated from $${Number(payment.amount_usd).toFixed(2)} to $${newAmountUsd.toFixed(2)} by our team.`
  );
  await logActivity({
    ...actorInfo(req), action: "edited_payment_amount", targetType: "payment", targetId: row.id,
    details: { previousAmountUsd: Number(payment.amount_usd), newAmountUsd }
  });
  res.json({ payment: row });
});

// ---- Subscriptions ----

adminRouter.get("/subscriptions", requireSection("subscriptions"), async (req, res) => {
  const status = req.query.status;
  const search = (req.query.search || "").trim();
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`sub.status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    conditions.push(`(
      lower(s.first_name) LIKE $${idx} OR lower(s.last_name) LIKE $${idx}
      OR lower(s.email) LIKE $${idx} OR lower(s.shopper_code) LIKE $${idx}
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query(
    `SELECT sub.*, s.first_name, s.last_name, s.shopper_code, s.email FROM subscriptions sub JOIN shoppers s ON s.id = sub.shopper_id
     ${where} ORDER BY sub.created_at DESC`,
    params
  );
  res.json({ subscriptions: result.rows });
});

// ---- Settings ----

adminRouter.get("/settings", requireSection("settings"), async (req, res) => {
  res.json({ settings: await getAllSettings() });
});

adminRouter.put("/settings/:key", requireSection("settings"), async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value === null || value === "") {
    return res.status(400).json({ error: "A value is required." });
  }
  await setSetting(req.params.key, String(value));
  await logActivity({ ...actorInfo(req), action: "updated_setting", targetType: "setting", details: { key: req.params.key, value: String(value) } });
  res.json({ key: req.params.key, value: String(value) });
});
