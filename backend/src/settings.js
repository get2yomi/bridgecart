import { query } from "./db/pool.js";

export async function getSetting(key) {
  const result = await query("SELECT value FROM settings WHERE key = $1", [key]);
  return result.rows[0]?.value ?? null;
}

export async function getSettings(keys) {
  const result = await query("SELECT key, value FROM settings WHERE key = ANY($1)", [keys]);
  const map = {};
  for (const row of result.rows) map[row.key] = row.value;
  return map;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

export async function getAllSettings() {
  const result = await query("SELECT key, value, updated_at FROM settings ORDER BY key");
  return result.rows;
}

export const FREIGHT_SETTING_KEYS = {
  air: { rate: "freight_air_rate_per_lb", min: "freight_air_min_usd" },
  express: { rate: "freight_express_rate_per_lb", min: "freight_express_min_usd" },
  sea: { rate: "freight_sea_rate_per_lb", min: "freight_sea_min_usd" }
};

export async function getFreightRates() {
  const keys = Object.values(FREIGHT_SETTING_KEYS).flatMap((speed) => [speed.rate, speed.min]);
  const settings = await getSettings(keys);
  const rates = {};
  for (const [speed, { rate, min }] of Object.entries(FREIGHT_SETTING_KEYS)) {
    rates[speed] = { rate: Number(settings[rate]), min: Number(settings[min]) };
  }
  return rates;
}
