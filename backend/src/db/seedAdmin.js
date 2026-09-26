import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;

if (!email || !password) {
  console.error("Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in backend/.env before running this script.");
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 12);
await pool.query(
  `INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
  [email.toLowerCase().trim(), passwordHash]
);
console.log(`Admin user ready: ${email}`);
await pool.end();
