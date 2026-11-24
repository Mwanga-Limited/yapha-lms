import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import { config } from '../config.js';
import { consumeUserToken } from './tokens.js';

authenticator.options = { window: 1 };

/*
 * Authenticator-app secrets are encrypted in the database (AES-256-GCM, key from TOTP_ENCRYPTION_KEY, which lives in the
 * secret manager and never in the database), so a database leak does not hand out second factors.
 * Stored form: "enc:v1:<iv>:<tag>:<ciphertext>" (base64url). Rows written before encryption existed are plain base32 and are
 * still read; `npm run secrets:encrypt-totp` converts them.
 */
export const isSealed = (v) => typeof v === 'string' && v.startsWith('enc:v1:');

export function seal(secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.totpKey, iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

export function open(stored) {
  if (!stored) return null;
  if (!isSealed(stored)) return stored;
  const [, , iv, tag, ct] = stored.split(':');
  for (const key of [config.totpKey, config.totpKeyPrevious].filter(Boolean)) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch { /* try the previous key */ }
  }
  throw new Error('Cannot decrypt an authenticator secret: TOTP_ENCRYPTION_KEY does not match the data');
}

/** True when a stored secret is plain text, or encrypted with a key other than the current one (so it should be rewritten). */
export function needsReseal(stored) {
  if (!stored) return false;
  if (!isSealed(stored)) return true;
  const [, , iv, tag, ct] = stored.split(':');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', config.totpKey, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    d.update(Buffer.from(ct, 'base64url')); d.final();
    return false;
  } catch { return true; }
}

/** Is `code` the current authenticator code? Each 30-second step can be used once: a replayed code is refused. */
export async function checkTotp(db, user, code) {
  const secret = open(user.totp_secret);
  if (!user.totp_enabled || !secret) return false;
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null || delta === undefined) return false;
  const step = Math.floor(Date.now() / 30_000) + delta;
  const { rowCount } = await db.query(`UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`, [user.id, step]);
  return rowCount === 1;
}

/** Check a code while setting up (not yet enabled): no replay bookkeeping. */
export const checkSetupCode = (user, code) => {
  const secret = open(user.totp_secret);
  return !!secret && authenticator.check(code, secret);
};

// ---------------------------------------------------------------- recovery codes
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_COUNT = 10;
const recoveryKey = Buffer.from(crypto.hkdfSync('sha256', config.totpKey, '', 'recovery-codes', 32));
const normalise = (c) => String(c).toUpperCase().replace(/[\s-]/g, '');
const hashCode = (c) => crypto.createHmac('sha256', recoveryKey).update(normalise(c)).digest('hex');
export const looksLikeRecoveryCode = (c) => /^[A-HJ-NP-Z2-9]{10}$/.test(normalise(c));

function newCode() {
  const chars = [...crypto.randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join('');   // 32 symbols: no modulo bias
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** Replace all recovery codes of a user with a fresh set; returns them in clear, once. */
export async function issueRecoveryCodes(db, userId) {
  await db.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
  const codes = Array.from({ length: RECOVERY_COUNT }, newCode);
  for (const c of codes) await db.query(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1,$2)`, [userId, hashCode(c)]);
  return codes;
}
export async function useRecoveryCode(db, userId, code) {
  const { rowCount } = await db.query(`UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`, [userId, hashCode(code)]);
  return rowCount === 1;
}
export async function recoveryCodesLeft(db, userId) {
  const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  return r.n;
}
export const clearRecoveryCodes = (db, userId) => db.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);

/**
 * The second step of sign-in. With an authenticator app: the app's code or a recovery code, and never an emailed code
 * (otherwise a stolen mailbox would defeat the app). Without one: the emailed code.
 * Returns 'totp' | 'recovery' | 'email' | null.
 */
export async function verifySecondFactor(db, user, code) {
  const c = String(code).trim();
  if (user.totp_enabled) {
    if (/^\d{6}$/.test(c)) return (await checkTotp(db, user, c)) ? 'totp' : null;
    if (looksLikeRecoveryCode(c)) return (await useRecoveryCode(db, user.id, c)) ? 'recovery' : null;
    return null;
  }
  return /^\d{6}$/.test(c) && (await consumeUserToken(db, c, 'mfa_email', user.id)) ? 'email' : null;
}
