import { query } from "./db/pool.js";

export async function logActivity({ actorId, actorName, action, targetType, targetId, details, actorType = "staff" }) {
  try {
    await query(
      `INSERT INTO activity_log (actor_id, actor_name, action, target_type, target_id, details, actor_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actorId || null, actorName || null, action, targetType || null, targetId || null, details ? JSON.stringify(details) : null, actorType]
    );
  } catch (error) {
    console.error("Failed to log activity:", error.message);
  }
}
