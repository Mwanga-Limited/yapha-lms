import { pool } from '../db.js';

/** express-rate-limit store in PostgreSQL, so the limits hold across every Cloud Run instance. (No row-level security on this table.) */
export class PgRateLimitStore {
  localKeys = false;
  prefix = '';
  init(options) { this.windowMs = options.windowMs; }
  k(key) { return `${this.prefix}${key}`; }
  async increment(key) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN now() + make_interval(secs => $2) ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`, [this.k(key), this.windowMs / 1000]);
    return { totalHits: r.hits, resetTime: r.reset_at };
  }
  async decrement(key) { await pool.query(`UPDATE rate_limits SET hits = greatest(hits - 1, 0) WHERE key = $1`, [this.k(key)]); }
  async resetKey(key) { await pool.query(`DELETE FROM rate_limits WHERE key = $1`, [this.k(key)]); }
}

export const purgeRateLimits = () => pool.query(`DELETE FROM rate_limits WHERE reset_at < now()`);
