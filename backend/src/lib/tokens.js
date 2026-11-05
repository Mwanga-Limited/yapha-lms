import crypto from 'node:crypto';

export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
export const randomCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** Create a single-use token for a user. Earlier unused tokens of the same purpose are invalidated. */
export async function issueUserToken(db, userId, purpose, ttlMinutes, raw = randomToken()) {
  await db.query(`UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await db.query(
    `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
    [userId, purpose, sha256(raw), ttlMinutes],
  );
  return raw;
}

/** Consume a token; returns the user id or null if invalid/expired/used. */
export async function consumeUserToken(db, raw, purpose, userId = null) {
  const { rows } = await db.query(
    `UPDATE user_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        AND ($3::uuid IS NULL OR user_id = $3)
      RETURNING user_id`,
    [sha256(raw), purpose, userId],
  );
  return rows[0]?.user_id ?? null;
}
