import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { fail } from './errors.js';

/*
 * Limits on mailing ONE address, across every organisation, and the "stop these emails" list.
 * Addresses are only ever stored as keyed hashes here.
 */
const hashKey = Buffer.from(crypto.hkdfSync('sha256', config.jwtSecret, '', 'mail-hash', 32));
export const emailHash = (email) => crypto.createHmac('sha256', hashKey).update(String(email).trim().toLowerCase()).digest('hex');

export const INVITE_LIMITS = { perDay: 3, perMonth: 10 };

/** Kinds of email that go to an address chosen by someone else, so the recipient may refuse them. */
export const SUPPRESSIBLE_KINDS = new Set(['invite', 'verify']);

export async function isSuppressed(db, hash) {
  const { rowCount } = await db.query(`SELECT 1 FROM mail_suppressions WHERE email_hash = $1`, [hash]);
  return rowCount > 0;
}

/** Refuse an invitation to an address that opted out or was invited too often by anyone; otherwise record it. */
export async function reserveInvite(db, email) {
  const hash = emailHash(email);
  if (await isSuppressed(db, hash)) fail(409, 'This address has asked not to receive invitations, so it cannot be invited.', { code: 'RECIPIENT_OPTED_OUT' });
  const { rows: [c] } = await db.query(
    `SELECT count(*) FILTER (WHERE sent_at > now() - interval '24 hours')::int AS day, count(*)::int AS month
       FROM mail_recipients WHERE email_hash = $1 AND kind = 'invite' AND sent_at > now() - interval '30 days'`, [hash]);
  if (c.day >= INVITE_LIMITS.perDay || c.month >= INVITE_LIMITS.perMonth) {
    fail(429, 'This address has received too many invitations recently. Try again later, or ask the person to sign up themselves.', { code: 'RECIPIENT_LIMIT' });
  }
  await db.query(`INSERT INTO mail_recipients (email_hash, kind) VALUES ($1, 'invite')`, [hash]);
}

// ---- "stop these emails": a signed link in every invitation
export const signStopToken = (email) => jwt.sign({ typ: 'stop-emails', h: emailHash(email) }, config.jwtSecret, { expiresIn: '365d' });
export function readStopToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return p.typ === 'stop-emails' && /^[0-9a-f]{64}$/.test(p.h) ? p.h : null;
  } catch { return null; }
}
export async function suppress(db, hash, reason = 'recipient_request') {
  await db.query(`INSERT INTO mail_suppressions (email_hash, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [hash, reason]);
}
