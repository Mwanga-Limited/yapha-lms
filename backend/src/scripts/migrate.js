import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { pool } from '../db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function migrate({ quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      log(`applied ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`${file}: ${e.message}`);
    } finally { client.release(); }
  }
  // Least-privilege runtime role: the app can read and append to the audit log, never change it.
  if (config.appDbUser) {
    const r = `"${config.appDbUser.replace(/"/g, '')}"`;
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${r};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r};
      REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM ${r};
      REVOKE DELETE, TRUNCATE ON users FROM ${r};
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM ${r};`);
    log(`granted runtime privileges to ${config.appDbUser} (audit_logs: SELECT, INSERT only)`);
  }
  log('database is up to date');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
}
