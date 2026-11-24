import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertIsolation } from '../lib/isolation.js';
import { config } from '../config.js';
import { pool } from '../db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

const LOCK_KEY = 727_274_001;   // advisory lock so two deployments never migrate at the same time
const migrationFiles = () => fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

/** Migration files that have not been applied yet (used by the health check). */
export async function pendingMigrations() {
  const { rows } = await pool.query(`SELECT to_regclass('public.schema_migrations') AS t`);
  if (!rows[0].t) return migrationFiles();
  const done = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  return migrationFiles().filter((f) => !done.has(f));
}

export async function migrate({ quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  // Migrations take a session-level advisory lock and run DDL: they need a direct connection, not a pooler (DATABASE_URL_UNPOOLED).
  const direct = config.databaseUrlUnpooled === config.databaseUrl ? pool : new pg.Pool({ connectionString: config.databaseUrlUnpooled, max: 3, connectionTimeoutMillis: 20_000 });
  const lock = await direct.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await direct.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await direct.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
    for (const file of migrationFiles()) {
      if (done.has(file)) continue;
      const client = await direct.connect();
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
    await grantAndVerify(direct, log);
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    lock.release();
    if (direct !== pool) await direct.end().catch(() => {});
  }
}

/** Every request runs SET LOCAL ROLE yapha_app. If the connecting user may not do that, nothing works,
 *  so check it here, loudly, instead of letting every request fail later. */
async function canSwitchToRuntimeRole(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE yapha_app');
    return null;
  } catch (e) {
    return e;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function verifyRuntimeRole(pool, log) {
  let problem = await canSwitchToRuntimeRole(pool);
  if (problem) {
    // PostgreSQL 16+: a non-superuser owner that created the role is its admin but may not SET ROLE to it until it grants itself that.
    // (Migration 003 tries a plain GRANT and ignores a failure, so repair it here where it can be reported.)
    try { await pool.query('GRANT yapha_app TO CURRENT_USER WITH SET TRUE'); } catch { /* handled below */ }
    problem = await canSwitchToRuntimeRole(pool);
    if (!problem) log('granted the database user permission to switch to the yapha_app role');
  }
  if (problem) throw new Error(`The database user cannot switch to the "yapha_app" role (${problem.message}). Run, as a user with CREATEROLE: GRANT yapha_app TO <database user> WITH SET TRUE;`);
}

async function grantAndVerify(pool, log) {
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
  await verifyRuntimeRole(pool, log);
  await assertIsolation(pool);
  log('tenant isolation verified (row-level security is on, forced and effective)');
  log('database is up to date');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
}
