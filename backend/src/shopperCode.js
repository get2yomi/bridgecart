import { query } from "./db/pool.js";

export async function generateShopperCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `NB-${Math.floor(10000 + Math.random() * 90000)}`;
    const existing = await query("SELECT 1 FROM shoppers WHERE shopper_code = $1", [candidate]);
    if (existing.rowCount === 0) return candidate;
  }
  throw new Error("Could not generate a unique shopper code.");
}
