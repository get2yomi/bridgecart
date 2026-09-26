import { Router } from "express";
import { getSetting } from "../settings.js";

export const settingsPublicRouter = Router();

// Unauthenticated on purpose — the shopper needs to see this fee in the live quote preview before logging in.
settingsPublicRouter.get("/quality-inspection-fee", async (req, res) => {
  const value = await getSetting("quality_inspection_fee_usd");
  res.json({ qualityInspectionFeeUsd: Number(value) || 0 });
});
