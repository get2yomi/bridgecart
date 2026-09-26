import { query } from "../db/pool.js";
import { hasSectionAccess } from "../permissions.js";

export function requireShopper(req, res, next) {
  if (!req.session.shopperId) return res.status(401).json({ error: "Please log in." });
  next();
}

export async function requireVerifiedShopper(req, res, next) {
  if (!req.session.shopperId) return res.status(401).json({ error: "Please log in." });
  const result = await query("SELECT verification_status FROM shoppers WHERE id = $1", [req.session.shopperId]);
  const shopper = result.rows[0];
  if (!shopper || shopper.verification_status !== "approved") {
    return res.status(403).json({ error: "Your account is not yet approved for orders." });
  }
  next();
}

export async function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: "Admin login required." });

  const result = await query("SELECT id, role, is_active FROM admin_users WHERE id = $1", [req.session.adminId]);
  const admin = result.rows[0];
  if (!admin || admin.is_active === false) {
    return req.session.destroy(() => res.status(401).json({ error: "Your account has been deactivated." }));
  }

  // Re-fetched live on every request so a role change or deactivation takes effect on the very next call.
  req.session.adminRole = admin.role;
  req.adminUser = admin;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.adminId) return res.status(401).json({ error: "Admin login required." });
    const role = req.adminUser?.role || req.session.adminRole;
    if (!roles.includes(role)) {
      return res.status(403).json({ error: "You do not have permission to perform this action." });
    }
    next();
  };
}

export function requireSection(sectionKey) {
  return async (req, res, next) => {
    if (!req.session.adminId) return res.status(401).json({ error: "Admin login required." });
    const role = req.adminUser?.role || req.session.adminRole;
    const allowed = await hasSectionAccess(req.session.adminId, role, sectionKey);
    if (!allowed) {
      return res.status(403).json({ error: "You do not have access to this section." });
    }
    next();
  };
}

// For routes shared by more than one dashboard tab (e.g. a shopper detail view reachable
// from both Verifications and the Shoppers directory) — access via any one section is enough.
export function requireAnySection(...sectionKeys) {
  return async (req, res, next) => {
    if (!req.session.adminId) return res.status(401).json({ error: "Admin login required." });
    const role = req.adminUser?.role || req.session.adminRole;
    for (const sectionKey of sectionKeys) {
      if (await hasSectionAccess(req.session.adminId, role, sectionKey)) return next();
    }
    return res.status(403).json({ error: "You do not have access to this section." });
  };
}
