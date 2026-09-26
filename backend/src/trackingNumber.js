import crypto from "node:crypto";
import { query } from "./db/pool.js";

export async function generateTrackingNumber() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `NB-TRK-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const existing = await query("SELECT 1 FROM orders WHERE tracking_number = $1", [candidate]);
    if (existing.rowCount === 0) return candidate;
  }
  throw new Error("Could not generate a unique tracking number.");
}
