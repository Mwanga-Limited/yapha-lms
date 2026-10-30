// Creates the platform super admin, once (the platform-level equivalent of AD-01).
// The super admin sees every organisation; each organisation's first Admin is then created from the console.
// Usage: SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... SUPERADMIN_NAME="..." npm run seed:superadmin
// (Falls back to ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME from .env.)
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { pool, tx } from '../db.js';

const env = process.env;
const email = (env.SUPERADMIN_EMAIL || env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = env.SUPERADMIN_PASSWORD || env.ADMIN_PASSWORD || '';
const name = (env.SUPERADMIN_NAME || env.ADMIN_NAME || 'Platform Super Admin').trim();

try {
  const { rows } = await pool.query(`SELECT email FROM users WHERE role = 'superadmin'`);
  if (rows[0]) {
    console.log(`A super admin already exists (${rows[0].email}). Nothing to do.`);
  } else {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Set SUPERADMIN_EMAIL to a valid email');
    if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error('SUPERADMIN_PASSWORD must be at least 12 characters with letters and numbers');
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    await tx(async (db) => {
      const { rows: [u] } = await db.query(
        `INSERT INTO users (tenant_id, email, password_hash, name, role, email_verified_at) VALUES (NULL,$1,$2,$3,'superadmin', now()) RETURNING id`,
        [email, hash, name]);
      await db.query(`INSERT INTO audit_logs (tenant_id, actor_id, actor_email, actor_role, action, target_type, target_id, new_values)
                      VALUES (NULL, $1::uuid, $2, 'superadmin', 'platform.superadmin_seed', 'user', $1::text, $3)`,
        [u.id, email, JSON.stringify({ source: 'seed script' })]);
    });
    console.log(`Created the platform super admin: ${email}. Sign in at ${config.appUrl}/platform.`);
  }
} catch (e) {
  console.error(e.message.includes('users_platform_email_key') ? 'A super admin with that email already exists' : e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
