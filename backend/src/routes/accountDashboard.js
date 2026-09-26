import { Router } from "express";
import bcrypt from "bcryptjs";
import path from "node:path";
import { query } from "../db/pool.js";
import { requireShopper } from "../middleware/auth.js";
import { UPLOAD_ROOT } from "../upload.js";
import { sendShopperEmail } from "../email.js";
import { logActivity } from "../activityLog.js";

export const accountDashboardRouter = Router();

// Mirrors the same helper in orders.js — attaches each order's line items (with per-item image URLs pointing
// at the ownership-checked route below) to a list of order rows already scoped to the current shopper.
async function attachItemsToOrders(orders) {
  if (orders.length === 0) return orders;
  const orderIds = orders.map((o) => o.id);
  const itemsResult = await query(
    `SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY id ASC`,
    [orderIds]
  );
  const itemIds = itemsResult.rows.map((i) => i.id);
  const imagesResult = itemIds.length
    ? await query(`SELECT * FROM order_item_images WHERE order_item_id = ANY($1) ORDER BY id ASC`, [itemIds])
    : { rows: [] };

  const imagesByItem = new Map();
  for (const image of imagesResult.rows) {
    if (!imagesByItem.has(image.order_item_id)) imagesByItem.set(image.order_item_id, []);
    imagesByItem.get(image.order_item_id).push({
      id: image.id,
      url: `/api/account/order-items/${image.order_item_id}/image/${image.id}`
    });
  }

  const itemsByOrder = new Map();
  for (const item of itemsResult.rows) {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
    itemsByOrder.get(item.order_id).push({ ...item, images: imagesByItem.get(item.id) || [] });
  }

  return orders.map((order) => ({ ...order, items: itemsByOrder.get(order.id) || [] }));
}

accountDashboardRouter.get("/overview", requireShopper, async (req, res) => {
  const shopperId = req.session.shopperId;

  const shopperResult = await query(
    `SELECT id, first_name, last_name, payer_first_name, payer_last_name, email, username, phone,
            street_address, city, state, physical_street_address, physical_city, physical_state,
            shopper_code, id_type, id_number, nin,
            verification_status, verification_notes, us_address_line, created_at
     FROM shoppers WHERE id = $1`,
    [shopperId]
  );
  const shopper = shopperResult.rows[0];
  if (!shopper) return res.status(401).json({ error: "Not logged in." });

  const [idDocResult, selfieResult, ordersResult, paymentsResult, subscriptionsResult, statsResult, messagesResult] = await Promise.all([
    query("SELECT id FROM id_documents WHERE shopper_id = $1 ORDER BY uploaded_at DESC LIMIT 1", [shopperId]),
    query("SELECT id FROM selfie_photos WHERE shopper_id = $1 ORDER BY captured_at DESC LIMIT 1", [shopperId]),
    query(
      `SELECT id, shipping_speed, quote_breakdown, quote_total_usd, status, tracking_number, estimated_delivery_date,
              delivered_date, refund_status, refund_reason, refund_amount_usd, customs_fee_ngn, customs_fee_status,
              recipient_name, recipient_phone, shipping_street_address, shipping_city, shipping_state,
              quality_inspection_requested, items_subtotal_usd, items_tax_usd, items_duty_usd, created_at
       FROM orders WHERE shopper_id = $1 ORDER BY created_at DESC`,
      [shopperId]
    ),
    query(
      `SELECT id, order_id, subscription_id, charge_type, method, amount_usd, exchange_rate, amount_ngn,
              reference_code, status, decision_reason, created_at, confirmed_at
       FROM payments WHERE shopper_id = $1 ORDER BY created_at DESC`,
      [shopperId]
    ),
    query(
      "SELECT id, plan_price_usd, status, current_period_start, current_period_end, created_at FROM subscriptions WHERE shopper_id = $1 ORDER BY created_at DESC",
      [shopperId]
    ),
    query(
      `SELECT
         COUNT(*)::int AS total_orders,
         COALESCE(SUM(quote_total_usd), 0) AS total_quoted_usd
       FROM orders WHERE shopper_id = $1`,
      [shopperId]
    ),
    query(
      "SELECT id, subject, body, sender_type, sender_name, read_at, created_at FROM notifications WHERE shopper_id = $1 ORDER BY created_at DESC LIMIT 50",
      [shopperId]
    )
  ]);

  const confirmedPaidResult = await query(
    `SELECT COALESCE(SUM(amount_usd), 0) AS total_paid_usd, COUNT(*)::int AS confirmed_count
     FROM payments
     WHERE shopper_id = $1 AND status = 'confirmed' AND charge_type IN ('order_total', 'follow_up_charge')`,
    [shopperId]
  );
  const pendingDueResult = await query(
    `SELECT COALESCE(SUM(amount_usd), 0) AS pending_due_usd, COUNT(*)::int AS pending_count
     FROM payments
     WHERE shopper_id = $1 AND status = 'pending'`,
    [shopperId]
  );

  res.json({
    profile: {
      id: shopper.id,
      firstName: shopper.first_name,
      lastName: shopper.last_name,
      payerFirstName: shopper.payer_first_name,
      payerLastName: shopper.payer_last_name,
      email: shopper.email,
      username: shopper.username,
      phone: shopper.phone,
      streetAddress: shopper.street_address,
      city: shopper.city,
      state: shopper.state,
      physicalStreetAddress: shopper.physical_street_address,
      physicalCity: shopper.physical_city,
      physicalState: shopper.physical_state,
      shopperCode: shopper.shopper_code,
      usAddressLine: shopper.us_address_line,
      createdAt: shopper.created_at
    },
    kyc: {
      idType: shopper.id_type,
      idNumber: shopper.id_number,
      nin: shopper.nin,
      verificationStatus: shopper.verification_status,
      verificationNotes: shopper.verification_notes,
      hasIdDocument: idDocResult.rowCount > 0,
      hasSelfie: selfieResult.rowCount > 0
    },
    stats: {
      totalOrders: statsResult.rows[0].total_orders,
      totalQuotedUsd: Number(statsResult.rows[0].total_quoted_usd),
      totalPaidUsd: Number(confirmedPaidResult.rows[0].total_paid_usd),
      confirmedPaymentsCount: confirmedPaidResult.rows[0].confirmed_count,
      pendingDueUsd: Number(pendingDueResult.rows[0].pending_due_usd),
      pendingPaymentsCount: pendingDueResult.rows[0].pending_count,
      memberSince: shopper.created_at
    },
    orders: await attachItemsToOrders(ordersResult.rows),
    payments: paymentsResult.rows,
    subscriptions: subscriptionsResult.rows,
    messages: messagesResult.rows,
    unreadMessageCount: messagesResult.rows.filter((m) => m.sender_type === "admin" && !m.read_at).length
  });
});

accountDashboardRouter.post("/messages/:id/read", requireShopper, async (req, res) => {
  const result = await query(
    "UPDATE notifications SET read_at = now() WHERE id = $1 AND shopper_id = $2 AND read_at IS NULL RETURNING id",
    [req.params.id, req.session.shopperId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Message not found." });
  res.json({ message: "Marked as read." });
});

// Ownership-checked item image route: order_item_images -> order_items -> orders -> shopper_id === session.
// This is the current route new frontend code should use — one order can now have many items, each with
// several images, so a single "screenshot" URL per order no longer makes sense.
accountDashboardRouter.get("/order-items/:itemId/image/:imageId", requireShopper, async (req, res) => {
  const result = await query(
    `SELECT oii.file_path
     FROM order_item_images oii
     JOIN order_items oi ON oi.id = oii.order_item_id
     JOIN orders o ON o.id = oi.order_id
     WHERE oii.id = $1 AND oii.order_item_id = $2 AND o.shopper_id = $3`,
    [req.params.imageId, req.params.itemId, req.session.shopperId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Image not found." });

  const filename = path.basename(result.rows[0].file_path);
  const filePath = path.join(UPLOAD_ROOT, "order-item-images", filename);
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "Image not found." });
  });
});

// Back-compat: kept working for any old bookmarked/cached URL by resolving to that order's first item's
// first image against the new tables, rather than the old (now-legacy, no-longer-written) screenshot_path column.
accountDashboardRouter.get("/orders/:id/screenshot", requireShopper, async (req, res) => {
  const result = await query(
    `SELECT oii.file_path
     FROM order_item_images oii
     JOIN order_items oi ON oi.id = oii.order_item_id
     WHERE oi.order_id = $1
       AND oi.id = (SELECT id FROM order_items WHERE order_id = $1 ORDER BY id ASC LIMIT 1)
       AND EXISTS (SELECT 1 FROM orders o WHERE o.id = $1 AND o.shopper_id = $2)
     ORDER BY oii.id ASC LIMIT 1`,
    [req.params.id, req.session.shopperId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Screenshot not found." });

  const filename = path.basename(result.rows[0].file_path);
  const filePath = path.join(UPLOAD_ROOT, "order-item-images", filename);
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "Screenshot not found." });
  });
});

accountDashboardRouter.get("/id-document", requireShopper, async (req, res) => {
  const result = await query(
    "SELECT file_path FROM id_documents WHERE shopper_id = $1 ORDER BY uploaded_at DESC LIMIT 1",
    [req.session.shopperId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "No identification document on file." });

  const filename = path.basename(result.rows[0].file_path);
  const filePath = path.join(UPLOAD_ROOT, "id-documents", filename);
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "Document not found." });
  });
});

// "My own" only — shopperId always comes from the session, never from a request param, so there is no
// id-override surface for one shopper to reach another shopper's selfie through this route.
accountDashboardRouter.get("/selfie", requireShopper, async (req, res) => {
  const result = await query(
    "SELECT file_path FROM selfie_photos WHERE shopper_id = $1 ORDER BY captured_at DESC LIMIT 1",
    [req.session.shopperId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "No live photo on file." });

  const filename = path.basename(result.rows[0].file_path);
  const filePath = path.join(UPLOAD_ROOT, "selfie-photos", filename);
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "Photo not found." });
  });
});

// Ownership-checked payment receipt view: payments.shopper_id === session, same rigor as the selfie/
// id-document routes above (404 rather than 403 so a wrong id never confirms whether it belongs to someone else).
accountDashboardRouter.get("/payments/:id/receipt", requireShopper, async (req, res) => {
  const result = await query(
    "SELECT receipt_file_path, receipt_mime_type FROM payments WHERE id = $1 AND shopper_id = $2",
    [req.params.id, req.session.shopperId]
  );
  if (result.rowCount === 0 || !result.rows[0].receipt_file_path) {
    return res.status(404).json({ error: "Receipt not found." });
  }

  const filename = path.basename(result.rows[0].receipt_file_path);
  const filePath = path.join(UPLOAD_ROOT, "payment-receipts", filename);
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: "Receipt not found." });
  });
});

const PROFILE_FIELDS = [
  "phone", "streetAddress", "city", "state",
  "physicalStreetAddress", "physicalCity", "physicalState",
  "email", "username"
];
const PROFILE_COLUMN_BY_FIELD = {
  phone: "phone", streetAddress: "street_address", city: "city", state: "state",
  physicalStreetAddress: "physical_street_address", physicalCity: "physical_city", physicalState: "physical_state",
  email: "email", username: "username"
};

accountDashboardRouter.put("/profile", requireShopper, async (req, res) => {
  const shopperId = req.session.shopperId;
  const updates = {};

  for (const field of PROFILE_FIELDS) {
    if (req.body[field] === undefined) continue;
    const value = String(req.body[field] ?? "").trim();
    if (!value) {
      return res.status(400).json({ error: `${field} cannot be empty.` });
    }
    updates[field] = value;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No changes were submitted." });
  }

  if (updates.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const current = await query("SELECT email, phone, username FROM shoppers WHERE id = $1", [shopperId]);
  if (current.rowCount === 0) return res.status(401).json({ error: "Not logged in." });
  const before = current.rows[0];

  if (updates.email) {
    updates.email = updates.email.toLowerCase();
    const conflict = await query("SELECT 1 FROM shoppers WHERE lower(email) = $1 AND id != $2", [updates.email, shopperId]);
    if (conflict.rowCount > 0) return res.status(409).json({ error: "An account with this email already exists." });
  }
  if (updates.username) {
    updates.username = updates.username.toLowerCase();
    const conflict = await query("SELECT 1 FROM shoppers WHERE lower(username) = $1 AND id != $2", [updates.username, shopperId]);
    if (conflict.rowCount > 0) return res.status(409).json({ error: "That username is already taken." });
  }

  const setClauses = [];
  const params = [shopperId];
  for (const [field, value] of Object.entries(updates)) {
    params.push(value);
    setClauses.push(`${PROFILE_COLUMN_BY_FIELD[field]} = $${params.length}`);
  }

  const updated = await query(
    `UPDATE shoppers SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1
     RETURNING phone, street_address, city, state, physical_street_address, physical_city, physical_state, email, username`,
    params
  );

  await logActivity({
    actorType: "shopper", actorId: shopperId, actorName: null,
    action: "shopper_updated_profile", targetType: "shopper", targetId: shopperId,
    details: { fieldsChanged: Object.keys(updates) }
  });

  if ((updates.email && updates.email !== before.email) || (updates.phone && updates.phone !== before.phone)) {
    await sendShopperEmail(shopperId, "Your account details were updated",
      "Your NaijaBridge account contact details were just changed. If this wasn't you, please contact support immediately.");
  }

  const row = updated.rows[0];
  res.json({
    profile: {
      phone: row.phone, streetAddress: row.street_address, city: row.city, state: row.state,
      physicalStreetAddress: row.physical_street_address, physicalCity: row.physical_city, physicalState: row.physical_state,
      email: row.email, username: row.username
    }
  });
});

accountDashboardRouter.put("/password", requireShopper, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password are required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }

  const result = await query("SELECT password_hash FROM shoppers WHERE id = $1", [req.session.shopperId]);
  const shopper = result.rows[0];
  if (!shopper) return res.status(401).json({ error: "Not logged in." });

  const matches = await bcrypt.compare(currentPassword, shopper.password_hash);
  if (!matches) return res.status(401).json({ error: "Your current password is incorrect." });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await query("UPDATE shoppers SET password_hash = $1, updated_at = now() WHERE id = $2", [passwordHash, req.session.shopperId]);

  await logActivity({
    actorType: "shopper", actorId: req.session.shopperId, actorName: null,
    action: "shopper_changed_password", targetType: "shopper", targetId: req.session.shopperId
  });

  await sendShopperEmail(req.session.shopperId, "Your password was changed",
    "Your NaijaBridge account password was just changed. If this wasn't you, please contact support immediately.");

  res.json({ message: "Password updated." });
});
