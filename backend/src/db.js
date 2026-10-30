import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from './config.js';

// Return numeric columns as JS numbers and bigint counts as numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/*
 * Tenant scope.
 * Every API request runs inside ONE database transaction that:
 *   1. switches to the restricted role "elearning_app" (row-level security always applies), and
 *   2. sets app.tenant_id to the request's organisation, or app.bypass = on for the platform super admin.
 * PostgreSQL then only returns and accepts rows of that organisation, whatever the SQL says.
 * The scope (client, tenant, flags) lives in AsyncLocalStorage, so route code keeps calling query()/tx().
 */
const als = new AsyncLocalStorage();
export const currentScope = () => als.getStore() ?? null;

async function openScoped(client, scope) {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE elearning_app');
  await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass', $2, true)`,
    [scope.tenant?.id ?? '', scope.bypass ? 'on' : '']);
}

/** Run fn inside a tenant-scoped transaction. scope: { tenant, bypass } */
export async function withScope(scope, fn) {
  const client = await pool.connect();
  let sp = 0;
  let released = false;
  try {
    await openScoped(client, scope);
    // One connection per request: queries issued in parallel (Promise.all) are queued, in order.
    let chain = Promise.resolve();
    const serial = { query: (text, params) => { const r = chain.then(() => client.query(text, params)); chain = r.catch(() => {}); return r; } };
    const store = { ...scope, client: serial, nextSavepoint: () => `sp_${++sp}`, onRollback: [] };
    let result;
    try {
      result = await als.run(store, fn);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      released = true;
      // Records that must outlive a refused request (failed sign-ins, blocked attempts) are written again.
      for (const replay of store.onRollback) await withScope(scope, replay).catch((e) => console.error('[audit replay]', e.message));
      throw err;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    if (!released) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (!released) client.release();
  }
}

/** Run fn with the tenant context but no database transaction (used for emails after commit). */
export const runInContext = (scope, fn) => als.run({ tenant: scope.tenant ?? null, bypass: !!scope.bypass }, fn);

/** A separate, independently committed transaction with the same tenant scope.
 *  Used for audit entries that must survive even if the request itself is refused and rolled back. */
export function detached(fn) {
  const s = currentScope();
  return withScope({ tenant: s?.tenant ?? null, bypass: !!s?.bypass }, () => fn(currentScope().client));
}

/** Inside a platform (bypass) request: temporarily act inside one organisation, in the same transaction.
 *  Used by the super admin to create an organisation together with its first Admin. */
export async function asTenant(tenant, fn) {
  const s = currentScope();
  const c = s.client;
  await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass', '', true)`, [tenant.id]);
  try {
    return await als.run({ ...s, tenant, bypass: false }, fn);
  } finally {
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass', $2, true)`,
      [s.tenant?.id ?? '', s.bypass ? 'on' : '']).catch(() => {});
  }
}

/** Query in the current scope (request transaction), or directly on the pool outside requests (scripts). */
export const query = (text, params) => (currentScope()?.client ?? pool).query(text, params);

/** Object form for helpers that take a db handle. */
export const db = { query };

/** Run fn atomically. Inside a request this is a SAVEPOINT in the request transaction. */
export async function tx(fn) {
  const s = currentScope();
  if (s?.client) {
    const name = s.nextSavepoint();
    await s.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn(s.client);
      await s.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await s.client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
      throw err;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
