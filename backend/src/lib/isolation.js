// Tenant-isolation self-check. Organisations are kept apart by row-level security (RLS) and by the API running every
// request as the restricted role "yapha_app". That only holds if the database is configured exactly right, and a
// misconfiguration fails silently (everything works, but every organisation can see every other's data). So it is
// verified here, loudly: at the end of every migration and when the server starts.

const PROBE_TABLES = ['courses', 'enrollments', 'files', 'certificates', 'notifications'];   // tenant_id is NOT NULL on these

/** Returns a list of problems; an empty list means the isolation is intact. */
export async function isolationProblems(pool) {
  const problems = [];

  const { rows: [role] } = await pool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'yapha_app'`);
  if (!role) return ['the runtime role "yapha_app" does not exist (run the migrations)'];
  if (role.rolsuper) problems.push('"yapha_app" is a superuser, which ignores row-level security');
  if (role.rolbypassrls) problems.push('"yapha_app" has BYPASSRLS, which ignores row-level security');

  // Every table that has a tenant_id column must have RLS enabled AND forced (forced = it also binds the table's owner), with a policy.
  const { rows: tables } = await pool.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
  for (const t of tables) {
    if (!t.relrowsecurity) problems.push(`row-level security is not enabled on ${t.relname}`);
    else if (!t.relforcerowsecurity) problems.push(`row-level security is not forced on ${t.relname}`);
    if (t.policies === 0) problems.push(`${t.relname} has no row-level security policy`);
  }

  // Live probe: as yapha_app, scoped to an organisation that does not exist, no tenant row may be visible, and none may be insertable.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE yapha_app');
    await client.query(`SELECT set_config('app.tenant_id', gen_random_uuid()::text, true), set_config('app.bypass', '', true)`);
    for (const name of PROBE_TABLES) {
      if (!tables.some((t) => t.relname === name)) continue;
      const { rows: [r] } = await client.query(`SELECT count(*)::int AS n FROM ${name}`);
      if (r.n > 0) problems.push(`${name}: ${r.n} rows are visible to an unrelated organisation`);
    }
    await client.query(`SELECT set_config('app.tenant_id', '', true)`);
    for (const name of PROBE_TABLES) {
      if (!tables.some((t) => t.relname === name)) continue;
      const { rows: [r] } = await client.query(`SELECT count(*)::int AS n FROM ${name}`);
      if (r.n > 0) problems.push(`${name}: ${r.n} rows are visible with no organisation selected`);
    }
  } catch (e) {
    problems.push(`isolation probe failed: ${e.message}`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  return problems;
}

export async function assertIsolation(pool) {
  const problems = await isolationProblems(pool);
  if (problems.length) throw new Error(`Tenant isolation is NOT intact, refusing to continue:\n - ${problems.join('\n - ')}`);
}
