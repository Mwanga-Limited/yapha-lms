// Break-glass: a platform super admin lost their authenticator app AND recovery codes.
// Removes the app so they sign in with emailed codes again. Needs database access, so it leaves a clear audit trail.
// Usage: SUPERADMIN_EMAIL=owner@example.com npm run reset:superadmin-2fa
import { pool, tx } from '../db.js';

process.env.YAPHA_DB_BYPASS = 'on';
const email = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();

try {
  if (!email) throw new Error('Set SUPERADMIN_EMAIL');
  await tx(async (db) => {
    const { rows: [u] } = await db.query(`SELECT id FROM users WHERE tenant_id IS NULL AND role = 'superadmin' AND lower(email) = $1 FOR UPDATE`, [email]);
    if (!u) throw new Error('No platform super admin has that email');
    await db.query(`UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL, token_version = token_version + 1 WHERE id = $1`, [u.id]);
    await db.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [u.id]);
    await db.query(`INSERT INTO audit_logs (tenant_id, actor_role, action, target_type, target_id, new_values) VALUES (NULL, 'system', 'platform.2fa_reset_script', 'user', $1::text, $2)`,
      [u.id, JSON.stringify({ email, source: 'reset-superadmin-2fa script' })]);
  });
  console.log(`Two-step sign-in reset for ${email}. They now sign in with emailed codes and can set up the app again.`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
