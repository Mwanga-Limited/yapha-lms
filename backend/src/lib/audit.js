import { currentScope, detached } from '../db.js';

/**
 * Append an entry to the audit log (append-only; DB triggers block UPDATE/DELETE/TRUNCATE).
 * The entry belongs to the current organisation (or to the platform when there is none).
 * @param db  a pg client inside the request (rolled back with it), or null for entries that must be kept
 *            even if the request is refused (failed sign-ins, blocked attempts): they are written in the
 *            request and, if the request is rolled back, written again in a separate transaction.
 */
export async function audit(db, ctx, { action, targetType = null, targetId = null, oldValues = null, newValues = null, actor }) {
  const a = actor === undefined ? ctx?.user : actor;
  const params = [
    a?.id ?? null, a?.email ?? null, a?.isSuper ? 'superadmin' : (a?.role ?? null), action, targetType,
    targetId == null ? null : String(targetId),
    oldValues == null ? null : JSON.stringify(oldValues),
    newValues == null ? null : JSON.stringify(newValues),
    ctx?.ip ?? null, ctx?.ua ?? null,
  ];
  const sql = `INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, target_type, target_id, old_values, new_values, ip, user_agent)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  if (db) return void await db.query(sql, params);
  const scope = currentScope();
  if (!scope?.client) return void await detached((c) => c.query(sql, params));
  await scope.client.query(sql, params);
  scope.onRollback?.push(async () => {
    // The actor may have been created by the same (rolled back) request: then keep the entry without the link.
    await currentScope().client.query('SAVEPOINT a');
    try { await currentScope().client.query(sql, params); }
    catch { await currentScope().client.query('ROLLBACK TO SAVEPOINT a'); await currentScope().client.query(sql, [null, ...params.slice(1)]); }
  });
}
