import crypto from "node:crypto";
import { query } from "./db/pool.js";

export async function generateResetToken() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = crypto.randomBytes(24).toString("hex");
    const existing = await query("SELECT 1 FROM shoppers WHERE reset_token = $1", [candidate]);
    if (existing.rowCount === 0) return candidate;
  }
  throw new Error("Could not generate a unique reset token.");
}
