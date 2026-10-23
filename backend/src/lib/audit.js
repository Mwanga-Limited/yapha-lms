import { pool } from '../db.js';

/**
 * Append an entry to the audit log (append-only; DB triggers block UPDATE/DELETE/TRUNCATE).
 * @param db     a pg client (inside a transaction) or null to use the pool directly.
 *               Blocked attempts are logged with the pool so they survive a rollback.
 */
export async function audit(db, ctx, { action, targetType = null, targetId = null, oldValues = null, newValues = null, actor }) {
  const a = actor === undefined ? ctx?.user : actor;
  await (db || pool).query(
    `INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, target_type, target_id, old_values, new_values, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      a?.id ?? null, a?.email ?? null, a?.role ?? null, action, targetType,
      targetId == null ? null : String(targetId),
      oldValues == null ? null : JSON.stringify(oldValues),
      newValues == null ? null : JSON.stringify(newValues),
      ctx?.ip ?? null, ctx?.ua ?? null,
    ],
  );
}
