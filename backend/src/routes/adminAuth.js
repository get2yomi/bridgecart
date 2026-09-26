import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db/pool.js";

export const adminAuthRouter = Router();

adminAuthRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

  const result = await query("SELECT * FROM admin_users WHERE email = $1", [email.toLowerCase().trim()]);
  const admin = result.rows[0];
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  if (admin.is_active === false) {
    return res.status(403).json({ error: "This account has been deactivated." });
  }

  const fullName = `${admin.first_name} ${admin.last_name}`;
  req.session.adminId = admin.id;
  req.session.adminRole = admin.role;
  req.session.adminName = fullName;
  res.json({ id: admin.id, email: admin.email, role: admin.role, fullName });
});

adminAuthRouter.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ message: "Logged out." }));
});

adminAuthRouter.get("/me", async (req, res) => {
  if (!req.session.adminId) return res.status(401).json({ error: "Not logged in." });
  res.json({ id: req.session.adminId, role: req.session.adminRole, fullName: req.session.adminName });
});
