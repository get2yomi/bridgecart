import { Router } from "express";
import crypto from "node:crypto";
import { query } from "../db/pool.js";
import { requireVerifiedShopper } from "../middleware/auth.js";
import { getSettings } from "../settings.js";
import { logActivity } from "../activityLog.js";
import { uploadReceipt } from "../upload.js";

export const paymentsRouter = Router();

function generateReferenceCode() {
  return `NB-PAY-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

paymentsRouter.get("/bank-details", requireVerifiedShopper, async (req, res) => {
  const settings = await getSettings([
    "usd_to_ngn_rate",
    "bank_transfer_account_name",
    "bank_transfer_account_number",
    "bank_transfer_bank_name"
  ]);
  res.json({
    exchangeRate: Number(settings.usd_to_ngn_rate),
    accountName: settings.bank_transfer_account_name,
    accountNumber: settings.bank_transfer_account_number,
    bankName: settings.bank_transfer_bank_name
  });
});

paymentsRouter.post("/", requireVerifiedShopper, async (req, res) => {
  const { orderId, subscriptionId, method } = req.body;
  if (!["card", "bank_transfer"].includes(method)) {
    return res.status(400).json({ error: "Invalid payment method." });
  }
  if (!orderId && !subscriptionId) {
    return res.status(400).json({ error: "A payment must reference an order or a subscription." });
  }

  let amountUsd;
  if (orderId) {
    const order = await query("SELECT quote_total_usd FROM orders WHERE id = $1 AND shopper_id = $2", [orderId, req.session.shopperId]);
    if (order.rowCount === 0) return res.status(404).json({ error: "Order not found." });

    // A follow-up charge (or any other admin-created pending payment) already has its own amount/reference —
    // reuse it instead of inserting a duplicate row priced off the full order total.
    const existingPending = await query(
      "SELECT * FROM payments WHERE order_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [orderId]
    );
    if (existingPending.rowCount > 0) {
      return res.status(201).json({ payment: existingPending.rows[0] });
    }

    amountUsd = Number(order.rows[0].quote_total_usd);
  } else {
    const sub = await query("SELECT plan_price_usd FROM subscriptions WHERE id = $1 AND shopper_id = $2", [subscriptionId, req.session.shopperId]);
    if (sub.rowCount === 0) return res.status(404).json({ error: "Subscription not found." });
    amountUsd = Number(sub.rows[0].plan_price_usd);
  }

  const settings = await getSettings(["usd_to_ngn_rate"]);
  const exchangeRate = Number(settings.usd_to_ngn_rate);
  const amountNgn = Math.round(amountUsd * exchangeRate * 100) / 100;
  const referenceCode = generateReferenceCode();

  const inserted = await query(
    `INSERT INTO payments (order_id, subscription_id, shopper_id, method, amount_usd, exchange_rate, amount_ngn, reference_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, method, amount_usd, amount_ngn, exchange_rate, reference_code, status, created_at`,
    [orderId || null, subscriptionId || null, req.session.shopperId, method, amountUsd, exchangeRate, amountNgn, referenceCode]
  );

  if (orderId) {
    await query("UPDATE orders SET status = 'awaiting_payment', updated_at = now() WHERE id = $1", [orderId]);
  }

  await logActivity({
    actorType: "shopper", actorId: req.session.shopperId, actorName: null,
    action: "shopper_created_payment", targetType: "payment", targetId: inserted.rows[0].id,
    details: { orderId: orderId || null, subscriptionId: subscriptionId || null, amountUsd }
  });

  res.status(201).json({ payment: inserted.rows[0] });
});

paymentsRouter.get("/mine", requireVerifiedShopper, async (req, res) => {
  const result = await query(
    "SELECT * FROM payments WHERE shopper_id = $1 ORDER BY created_at DESC",
    [req.session.shopperId]
  );
  res.json({ payments: result.rows });
});

// A receipt is attached to a payment that already exists — shoppers often don't have the file at hand
// the moment they create the payment record, so this is a separate step, callable any time before or after
// confirmation (re-attaching simply overwrites the stored reference; the old file is left on disk, matching
// how other upload routes in this app handle replacement).
paymentsRouter.post("/:id/receipt", requireVerifiedShopper, uploadReceipt.single("receipt"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "A receipt file is required." });

  const existing = await query(
    "SELECT id FROM payments WHERE id = $1 AND shopper_id = $2",
    [req.params.id, req.session.shopperId]
  );
  if (existing.rowCount === 0) return res.status(404).json({ error: "Payment not found." });

  const updated = await query(
    `UPDATE payments SET receipt_file_path = $2, receipt_mime_type = $3 WHERE id = $1 RETURNING *`,
    [req.params.id, req.file.filename, req.file.mimetype]
  );

  await logActivity({
    actorType: "shopper", actorId: req.session.shopperId, actorName: null,
    action: "shopper_attached_payment_receipt", targetType: "payment", targetId: Number(req.params.id),
    details: { mimeType: req.file.mimetype }
  });

  res.json({ payment: updated.rows[0] });
});
