import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { sendShopperEmail } from "../email.js";

// Kept as its own router (not merged into admin.js) to avoid concurrent-edit conflicts with
// another agent working on admin.js — mounted at /api/admin in server.js alongside adminRouter.
export const customsFeeRouter = Router();

customsFeeRouter.put("/orders/:id/customs-fee", requireAdmin, async (req, res) => {
  const { customsFeeNgn, status } = req.body;
  if (!["not_applicable", "due", "paid"].includes(status)) {
    return res.status(400).json({ error: "Invalid customs fee status." });
  }
  const feeValue = customsFeeNgn === null || customsFeeNgn === undefined || customsFeeNgn === "" ? null : Number(customsFeeNgn);
  if (feeValue !== null && !Number.isFinite(feeValue)) {
    return res.status(400).json({ error: "Invalid customs fee amount." });
  }

  const updated = await query(
    `UPDATE orders SET customs_fee_ngn = $1, customs_fee_status = $2, updated_at = now()
     WHERE id = $3 RETURNING id, shopper_id, customs_fee_ngn, customs_fee_status`,
    [feeValue, status, req.params.id]
  );
  const order = updated.rows[0];
  if (!order) return res.status(404).json({ error: "Order not found." });

  const feeText = feeValue !== null ? `₦${Number(feeValue).toLocaleString()}` : "an amount to be confirmed";
  const message = status === "due"
    ? `A Nigeria customs fee of ${feeText} is due before you can collect this item.`
    : status === "paid"
      ? "Your Nigeria customs fee has been marked as paid."
      : "This order does not currently require a customs fee.";

  await query(
    `INSERT INTO order_updates (order_id, author_type, author_id, author_name, message, visible_to_shopper)
     VALUES ($1, 'staff', $2, $3, $4, true)`,
    [order.id, req.session.adminId, req.session.adminName || null, message]
  );

  if (status === "due") {
    await sendShopperEmail(order.shopper_id, "Customs fee due on your order", message);
  }

  res.json({ order });
});
