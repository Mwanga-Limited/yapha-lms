import pg from 'pg';

/** The newest email to an address, read from the backend's own outbox table (no mail server needed in tests). */
export async function lastMail(to: string, pattern: RegExp): Promise<string> {
  const pool = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    for (let i = 0; i < 30; i++) {
      const { rows } = await pool.query(`SELECT message->>'text' AS text FROM email_outbox WHERE to_email = $1 ORDER BY created_at DESC LIMIT 5`, [to]);
      const hit = rows.map((r) => r.text as string).find((t) => t && pattern.test(t));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`no email to ${to} matching ${pattern}`);
  } finally { await pool.end(); }
}
