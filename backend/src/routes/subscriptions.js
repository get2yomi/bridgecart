import { Router } from "express";
import { query } from "../db/pool.js";
import { requireVerifiedShopper } from "../middleware/auth.js";
import { getSetting } from "../settings.js";
import { logActivity } from "../activityLog.js";

export const subscriptionsRouter = Router();

subscriptionsRouter.post("/", requireVerifiedShopper, async (req, res) => {
  const existing = await query(
    "SELECT id FROM subscriptions WHERE shopper_id = $1 AND status IN ('pending_payment', 'active')",
    [req.session.shopperId]
  );
  if (existing.rowCount > 0) {
    return res.status(409).json({ error: "You already have an active or pending address subscription." });
  }

  const planPrice = Number(await getSetting("address_subscription_price_usd"));
  const inserted = await query(
    `INSERT INTO subscriptions (shopper_id, plan_price_usd) VALUES ($1, $2)
     RETURNING id, plan_price_usd, status, created_at`,
    [req.session.shopperId, planPrice]
  );

  await logActivity({
    actorType: "shopper", actorId: req.session.shopperId, actorName: null,
    action: "shopper_created_subscription", targetType: "subscription", targetId: inserted.rows[0].id
  });

  res.status(201).json({ subscription: inserted.rows[0] });
});

subscriptionsRouter.get("/mine", requireVerifiedShopper, async (req, res) => {
  const result = await query(
    "SELECT * FROM subscriptions WHERE shopper_id = $1 ORDER BY created_at DESC",
    [req.session.shopperId]
  );
  res.json({ subscriptions: result.rows });
});
