// AD-01: create the first Admin once, on first deployment.
// Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_NAME="..." npm run seed:admin
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { pool, tx } from '../db.js';

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';
const name = (process.env.ADMIN_NAME || 'Platform Admin').trim();

try {
  const { rows } = await pool.query(`SELECT email FROM users WHERE is_root`);
  if (rows[0]) {
    console.log(`The first Admin already exists (${rows[0].email}). Nothing to do.`);
  } else {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Set ADMIN_EMAIL to a valid email');
    if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error('ADMIN_PASSWORD must be at least 12 characters with letters and numbers');
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    await tx(async (db) => {
    const { rows: [u] } = await db.query(
      `INSERT INTO users (email, password_hash, name, role, is_root, email_verified_at) VALUES ($1,$2,$3,'admin',true, now()) RETURNING id`,
      [email, hash, name]);
    await db.query(`INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, target_type, target_id, new_values) VALUES ($1::uuid,$2,'admin','admin.seed','user',$1::text,$3)`,
      [u.id, email, JSON.stringify({ source: 'seed script' })]);
    });
    console.log(`Created the first Admin: ${email}. Sign in and set up two-factor authentication.`);
  }
} catch (e) {
  console.error(e.message.includes('users_email_lower_key') ? 'A user with that email already exists' : e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
