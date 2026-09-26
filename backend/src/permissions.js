import { query } from "./db/pool.js";

export const SECTIONS = [
  "verifications", "orders", "payments", "subscriptions", "settings", "staff", "approvals", "activity_log", "shoppers"
];

// Baseline access for newly created accounts, adjustable by the owner afterward via staff_permissions.
// staff: the day-to-day operational sections. supervisor: everything except staff management and settings,
// since those are the two areas with account/business-config blast radius reserved for owners.
export const DEFAULT_PERMISSIONS = {
  staff: ["verifications", "orders", "payments", "shoppers"],
  supervisor: ["verifications", "orders", "payments", "subscriptions", "approvals", "activity_log", "shoppers"],
  owner: []
};

export async function seedDefaultPermissions(staffId, role) {
  const sections = DEFAULT_PERMISSIONS[role] || [];
  for (const section of sections) {
    await query(
      `INSERT INTO staff_permissions (staff_id, section, can_access) VALUES ($1, $2, true)
       ON CONFLICT (staff_id, section) DO UPDATE SET can_access = true`,
      [staffId, section]
    );
  }
}

export async function getPermissionMap(staffId, role) {
  if (role === "owner") {
    const map = {};
    for (const section of SECTIONS) map[section] = true;
    return { permissions: map, ownerOverride: true };
  }
  const result = await query("SELECT section, can_access FROM staff_permissions WHERE staff_id = $1", [staffId]);
  const rows = new Map(result.rows.map((row) => [row.section, row.can_access]));
  const map = {};
  for (const section of SECTIONS) map[section] = rows.get(section) === true;
  return { permissions: map, ownerOverride: false };
}

export async function hasSectionAccess(staffId, role, section) {
  if (role === "owner") return true;
  const result = await query(
    "SELECT can_access FROM staff_permissions WHERE staff_id = $1 AND section = $2",
    [staffId, section]
  );
  return result.rows[0]?.can_access === true;
}
