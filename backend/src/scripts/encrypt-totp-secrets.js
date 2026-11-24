// Encrypts authenticator-app secrets that were stored in clear before encryption existed, and re-encrypts any that are
// sealed with TOTP_ENCRYPTION_KEY_PREVIOUS (key rotation). Safe to run any number of times; part of every deployment.
// Usage: npm run secrets:encrypt-totp
import { pool, query, tx } from '../db.js';
import { needsReseal, open, seal } from '../lib/totp.js';

// Row-level security is forced on every table: set the platform bypass flag for this script's own sessions.
process.env.YAPHA_DB_BYPASS = 'on';

try {
  const { rows } = await query(`SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL`);
  const todo = rows.filter((r) => needsReseal(r.totp_secret));
  await tx(async (db) => {
    for (const r of todo) await db.query(`UPDATE users SET totp_secret = $2 WHERE id = $1`, [r.id, seal(open(r.totp_secret))]);
  });
  console.log(`${todo.length} authenticator secret(s) encrypted with the current key; ${rows.length - todo.length} already were`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
