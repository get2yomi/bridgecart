import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";

export const shippingLabelRouter = Router();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

shippingLabelRouter.get("/orders/:id/label", requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT o.*, s.first_name, s.last_name, s.shopper_code, s.email
     FROM orders o JOIN shoppers s ON s.id = o.shopper_id WHERE o.id = $1`,
    [req.params.id]
  );
  if (result.rowCount === 0) return res.status(404).send("Order not found.");
  const order = result.rows[0];

  const itemsResult = await query(
    "SELECT item_title, weight_lb, quantity FROM order_items WHERE order_id = $1 ORDER BY id ASC",
    [order.id]
  );
  const items = itemsResult.rows;
  const itemSummary = items.length === 0
    ? "Untitled item"
    : items.length === 1
      ? (items[0].item_title || "Untitled item")
      : `${items[0].item_title || "Untitled item"} and ${items.length - 1} more item${items.length - 1 === 1 ? "" : "s"}`;
  const totalWeight = items.reduce((sum, item) => sum + Number(item.weight_lb) * Number(item.quantity), 0);

  const recipientName = order.recipient_name || `${order.first_name} ${order.last_name}`.trim();
  const recipientPhone = order.recipient_phone || "-";
  const addressLines = [order.shipping_street_address, order.shipping_city, order.shipping_state]
    .filter(Boolean).map(escapeHtml).join("<br>") || "-";

  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Shipping label — Order #${order.id}</title>
<style>
  @page { size: 4in 6in; margin: 0.2in; }
  * { box-sizing: border-box; }
  body { font-family: "DM Sans", Arial, sans-serif; color: #101a28; margin: 0; padding: 16px; }
  .label { border: 2px solid #101a28; border-radius: 8px; padding: 16px; }
  .brand { font-weight: 800; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; color: #0fa572; margin-bottom: 8px; }
  .section { margin-bottom: 12px; }
  .section-title { font-size: 10px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: #667085; margin-bottom: 2px; }
  .recipient-name { font-size: 20px; font-weight: 800; }
  .address { font-size: 15px; line-height: 1.5; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; border-top: 1px dashed #cbd3d9; padding-top: 12px; }
  .meta-grid div span { display: block; font-size: 9px; color: #667085; text-transform: uppercase; letter-spacing: .5px; }
  .meta-grid div b { font-size: 13px; }
  .tracking { margin-top: 12px; padding: 8px; text-align: center; background: #f5f7f9; border-radius: 6px; font-size: 16px; font-weight: 800; letter-spacing: 1px; }
  .print-button { margin: 16px 0; padding: 10px 18px; font-size: 14px; font-weight: 700; cursor: pointer; border: 0; border-radius: 8px; background: #0fa572; color: white; }
  @media print { .print-button { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  <button class="print-button" onclick="window.print()">Print label</button>
  <div class="label">
    <div class="brand">NaijaBridge</div>
    <div class="section">
      <div class="section-title">Ship to</div>
      <div class="recipient-name">${escapeHtml(recipientName)}</div>
      <div class="address">${addressLines}</div>
    </div>
    <div class="section">
      <div class="section-title">Phone</div>
      <div class="address">${escapeHtml(recipientPhone)}</div>
    </div>
    <div class="tracking">${escapeHtml(order.tracking_number || "No tracking number yet")}</div>
    <div class="meta-grid">
      <div><span>Order number</span><b>#${order.id}</b></div>
      <div><span>Shopper code</span><b>${escapeHtml(order.shopper_code)}</b></div>
      <div><span>Item</span><b>${escapeHtml(itemSummary)}</b></div>
      <div><span>Weight</span><b>${escapeHtml(totalWeight.toFixed(2))} lb</b></div>
      <div><span>Shopper email</span><b>${escapeHtml(order.email)}</b></div>
      <div><span>Shopper phone</span><b>${escapeHtml(order.recipient_phone || "-")}</b></div>
    </div>
  </div>
</body>
</html>`);
});
