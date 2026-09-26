import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db/pool.js";
import { requireAdmin, requireRole, requireSection } from "../middleware/auth.js";
import { logActivity } from "../activityLog.js";
import { SECTIONS, seedDefaultPermissions, getPermissionMap } from "../permissions.js";

export const staffRouter = Router();
staffRouter.use(requireAdmin);
staffRouter.use(requireSection("staff"));

staffRouter.get("/", async (req, res) => {
  const { role, isActive } = req.query;
  const search = (req.query.search || "").trim();
  const conditions = [];
  const params = [];
  if (role) { params.push(role); conditions.push(`role = $${params.length}`); }
  if (isActive !== undefined) { params.push(isActive === "true"); conditions.push(`is_active = $${params.length}`); }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    conditions.push(`(
      lower(first_name) LIKE $${idx} OR lower(last_name) LIKE $${idx}
      OR lower(email) LIKE $${idx} OR lower(username) LIKE $${idx}
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await query(
    `SELECT id, first_name, last_name, email, username, role, is_active, created_at, phone, phone_carrier,
            reported, report_reason, reported_by, reported_at
     FROM admin_users ${where} ORDER BY created_at ASC`,
    params
  );
  res.json({ staff: result.rows });
});

// password_hash must never leave this route — every other staff route already SELECTs an explicit column
// list for the same reason; this one does too rather than relying on callers to strip it.
staffRouter.get("/:id", async (req, res) => {
  const targetId = Number(req.params.id);
  const result = await query(
    `SELECT id, first_name, last_name, username, email, phone, phone_carrier, role, is_active,
            reported, report_reason, reported_by, reported_at, created_at, created_by
     FROM admin_users WHERE id = $1`,
    [targetId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Staff account not found." });
  res.json({ staff: result.rows[0] });
});

// A staff member's own actions are logged with actor_type = 'staff' and actor_id = their admin_users.id
// (see activityLog.js's default actorType). Staff can also be the TARGET of an action another staff member
// took on them (created_staff_account, reported_staff, updated_staff_profile, etc., all logged with
// target_type = 'staff'), so both directions are combined here, mirroring GET /shoppers/:id/activity.
staffRouter.get("/:id/activity", async (req, res) => {
  const targetId = Number(req.params.id);
  const result = await query(
    `SELECT * FROM activity_log
     WHERE (actor_type = 'staff' AND actor_id = $1)
        OR (target_type IN ('staff', 'admin') AND target_id = $1)
     ORDER BY created_at DESC LIMIT 100`,
    [targetId]
  );
  res.json({ activity: result.rows });
});

staffRouter.post("/", requireRole("owner"), async (req, res) => {
  const { firstName, lastName, email, password, role, username } = req.body;
  if (!firstName || !lastName || !email || !password || !role || !username) {
    return res.status(400).json({ error: "First name, last name, email, username, password, and role are required." });
  }
  if (!["owner", "supervisor", "staff"].includes(role)) {
    return res.status(400).json({ error: "Invalid role." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const normalizedUsername = username.trim().toLowerCase();
  const existing = await query("SELECT 1 FROM admin_users WHERE email = $1", [email.toLowerCase().trim()]);
  if (existing.rowCount > 0) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  const usernameTaken = await query("SELECT 1 FROM admin_users WHERE LOWER(username) = $1", [normalizedUsername]);
  if (usernameTaken.rowCount > 0) {
    return res.status(409).json({ error: "This username is already taken." });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const fullName = `${firstName.trim()} ${lastName.trim()}`;
  const inserted = await query(
    `INSERT INTO admin_users (first_name, last_name, full_name, email, username, password_hash, role, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, first_name, last_name, email, username, role, is_active, created_at`,
    [firstName.trim(), lastName.trim(), fullName, email.toLowerCase().trim(), normalizedUsername, passwordHash, role, req.session.adminId]
  );
  const staff = inserted.rows[0];
  await seedDefaultPermissions(staff.id, role);

  await logActivity({
    actorId: req.session.adminId,
    actorName: req.session.adminName,
    action: "created_staff_account",
    targetType: "staff",
    targetId: staff.id,
    details: { email: staff.email, role: staff.role }
  });

  res.status(201).json({ staff });
});

staffRouter.put("/:id", requireRole("owner", "supervisor"), async (req, res) => {
  const { role, isActive } = req.body;
  const targetId = Number(req.params.id);
  const isOwner = req.session.adminRole === "owner";

  // Only the owner may promote/demote roles — a supervisor may only toggle is_active.
  if (role !== undefined && !isOwner) {
    return res.status(403).json({ error: "Only the owner can change a staff member's role." });
  }
  if (role !== undefined && !["owner", "supervisor", "staff"].includes(role)) {
    return res.status(400).json({ error: "Invalid role." });
  }

  const current = await query("SELECT * FROM admin_users WHERE id = $1", [targetId]);
  if (current.rowCount === 0) return res.status(404).json({ error: "Staff account not found." });
  const target = current.rows[0];

  // A supervisor may not deactivate/reactivate an owner account.
  if (!isOwner && target.role === "owner") {
    return res.status(403).json({ error: "You do not have permission to modify an owner account." });
  }

  const willDeactivate = isActive === false && target.is_active !== false;
  const willDemote = role !== undefined && role !== "owner" && target.role === "owner";

  if (targetId === req.session.adminId && (willDeactivate || willDemote)) {
    return res.status(400).json({ error: "You cannot deactivate or demote your own account." });
  }

  if (willDeactivate || willDemote) {
    const activeOwners = await query(
      "SELECT COUNT(*)::int AS count FROM admin_users WHERE role = 'owner' AND is_active = true AND id != $1",
      [targetId]
    );
    if (activeOwners.rows[0].count === 0) {
      return res.status(400).json({ error: "At least one active owner must remain." });
    }
  }

  const nextRole = role !== undefined ? role : target.role;
  const nextActive = isActive !== undefined ? Boolean(isActive) : target.is_active;

  const updated = await query(
    `UPDATE admin_users SET role = $2, is_active = $3, updated_at = now() WHERE id = $1
     RETURNING id, first_name, last_name, email, role, is_active, created_at`,
    [targetId, nextRole, nextActive]
  );

  await logActivity({
    actorId: req.session.adminId,
    actorName: req.session.adminName,
    action: "updated_staff_account",
    targetType: "staff",
    targetId,
    details: { role: nextRole, isActive: nextActive }
  });

  res.json({ staff: updated.rows[0] });
});

staffRouter.put("/:id/profile", requireRole("owner"), async (req, res) => {
  const { firstName, lastName, email, phone, phoneCarrier } = req.body;
  const targetId = Number(req.params.id);
  if (!firstName || !firstName.trim() || !lastName || !lastName.trim() || !email || !email.trim()) {
    return res.status(400).json({ error: "First name, last name, and email are required." });
  }
  const normalizedEmail = email.toLowerCase().trim();

  const current = await query("SELECT id, first_name, last_name, email, phone, phone_carrier FROM admin_users WHERE id = $1", [targetId]);
  if (current.rowCount === 0) return res.status(404).json({ error: "Staff account not found." });
  const target = current.rows[0];

  const conflict = await query(
    "SELECT 1 FROM admin_users WHERE LOWER(email) = $1 AND id != $2",
    [normalizedEmail, targetId]
  );
  if (conflict.rowCount > 0) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const fullName = `${firstName.trim()} ${lastName.trim()}`;
  const nextPhone = phone !== undefined ? (phone.trim() || null) : target.phone;
  const nextPhoneCarrier = phoneCarrier !== undefined ? (phoneCarrier.trim() || null) : target.phone_carrier;
  const updated = await query(
    `UPDATE admin_users SET first_name = $2, last_name = $3, full_name = $4, email = $5, phone = $6, phone_carrier = $7, updated_at = now() WHERE id = $1
     RETURNING id, first_name, last_name, email, role, is_active, created_at, phone, phone_carrier`,
    [targetId, firstName.trim(), lastName.trim(), fullName, normalizedEmail, nextPhone, nextPhoneCarrier]
  );

  await logActivity({
    actorId: req.session.adminId,
    actorName: req.session.adminName,
    action: "updated_staff_profile",
    targetType: "staff",
    targetId,
    details: {
      before: { firstName: target.first_name, lastName: target.last_name, email: target.email },
      after: { firstName: firstName.trim(), lastName: lastName.trim(), email: normalizedEmail }
    }
  });

  res.json({ staff: updated.rows[0] });
});

staffRouter.put("/:id/password", requireRole("owner"), async (req, res) => {
  const { newPassword } = req.body;
  const targetId = Number(req.params.id);
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const current = await query("SELECT id FROM admin_users WHERE id = $1", [targetId]);
  if (current.rowCount === 0) return res.status(404).json({ error: "Staff account not found." });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await query("UPDATE admin_users SET password_hash = $2, updated_at = now() WHERE id = $1", [targetId, passwordHash]);

  await logActivity({
    actorId: req.session.adminId,
    actorName: req.session.adminName,
    action: "reset_staff_password",
    targetType: "staff",
    targetId
  });

  res.json({ message: "Password updated." });
});

staffRouter.delete("/:id", requireRole("owner"), async (req, res) => {
  const targetId = Number(req.params.id);

  if (targetId === req.session.adminId) {
    return res.status(400).json({ error: "You cannot delete your own account." });
  }

  const current = await query("SELECT id, first_name, last_name, email, role, is_active FROM admin_users WHERE id = $1", [targetId]);
  if (current.rowCount === 0) return res.status(404).json({ error: "Staff account not found." });
  const target = current.rows[0];

  if (target.role === "owner") {
    const activeOwners = await query(
      "SELECT COUNT(*)::int AS count FROM admin_users WHERE role = 'owner' AND is_active = true AND id != $1",
      [targetId]
    );
    if (activeOwners.rows[0].count === 0) {
      return res.status(400).json({ error: "At least one active owner must remain." });
    }
  }

  await logActivity({
    actorId: req.session.adminId,
    actorName: req.session.adminName,
    action: "deleted_staff_account",
    targetType: "staff",
    targetId,
    details: { email: target.email, fullName: `${target.first_name} ${target.last_name}`, role: target.role }
  });

  await query("DELETE FROM admin_users WHERE id = $1", [targetId]);

  res.json({ message: "Staff account deleted." });
});

// ---- Reported accounts (a supervisor flags a concern; only the owner can dismiss it) ----

staffRouter.put("/:id/report", requireRole("owner", "supervisor"), async (req, res) => {
  const { reason } = req.body;
  const targetId = Number(req.params.id);

  if (targetId === req.session.adminId) {
    return res.status(400).json({ error: "You cannot report your own account." });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: "A reason is required to report a staff account." });
  }

  const current = await query("SELECT id FROM admin_users WHERE id = $1", [targetId]);
  if (current.rowCount === 0) return res.status(404).json({ error: "Staff account not found." });

  const updated = await query(
    `UPDATE admin_users SET reported = true, report_reason = $2, reported_by = $3, reported_at = now(), updated_at = now()
     WHERE id = $1 RETURNING id, first_name, last_name, email, username, role, is_active, reported, report_reason, reported_by, reported_at`,
    [targetId, reason.trim(), req.session.adminId]
  );

  await logActivity({
    actorId: req.session.adminId,
    actorName: req.session.adminName,
    action: "reported_staff",
    targetType: "staff",
    targetId,
    details: { reason: reason.trim() }
  });

  res.json({ staff: updated.rows[0] });
});

staffRouter.put("/:id/unreport", requireRole("owner"), async (req, res) => {
  const targetId = Number(req.params.id);

  const current = await query("SELECT id FROM admin_users WHERE id = $1", [targetId]);
  if (current.rowCount === 0) return res.status(404).json({ error: "Staff account not found." });

  const updated = await query(
    `UPDATE admin_users SET reported = false, report_reason = NULL, reported_by = NULL, reported_at = NULL, updated_at = now()
     WHERE id = $1 RETURNING id, first_name, last_name, email, username, role, is_active, reported, report_reason, reported_by, reported_at`,
    [targetId]
  );

  await logActivity({
    actorId: req.session.adminId,
    actorName: req.session.adminName,
    action: "unreported_staff",
    targetType: "staff",
    targetId
  });

  res.json({ staff: updated.rows[0] });
});

// ---- Per-section permissions ----

staffRouter.get("/:id/permissions", requireRole("owner"), async (req, res) => {
  const targetId = Number(req.params.id);
  const current = await query("SELECT id, role FROM admin_users WHERE id = $1", [targetId]);
  if (current.rowCount === 0) return res.status(404).json({ error: "Staff account not found." });

  const { permissions, ownerOverride } = await getPermissionMap(targetId, current.rows[0].role);
  res.json({ sections: permissions, ownerOverride });
});

staffRouter.put("/:id/permissions", requireRole("owner"), async (req, res) => {
  const targetId = Number(req.params.id);
  const { sections } = req.body;
  if (!sections || typeof sections !== "object") {
    return res.status(400).json({ error: "A sections map is required." });
  }

  const current = await query("SELECT id, role FROM admin_users WHERE id = $1", [targetId]);
  if (current.rowCount === 0) return res.status(404).json({ error: "Staff account not found." });

  const { permissions: before } = await getPermissionMap(targetId, current.rows[0].role);
  const changes = {};

  for (const [section, canAccess] of Object.entries(sections)) {
    if (!SECTIONS.includes(section)) continue;
    const value = Boolean(canAccess);
    await query(
      `INSERT INTO staff_permissions (staff_id, section, can_access) VALUES ($1, $2, $3)
       ON CONFLICT (staff_id, section) DO UPDATE SET can_access = $3`,
      [targetId, section, value]
    );
    if (before[section] !== value) changes[section] = { before: before[section], after: value };
  }

  await logActivity({
    actorId: req.session.adminId,
    actorName: req.session.adminName,
    action: "updated_staff_permissions",
    targetType: "staff",
    targetId,
    details: { changes }
  });

  const { permissions: after } = await getPermissionMap(targetId, current.rows[0].role);
  res.json({ sections: after });
});
