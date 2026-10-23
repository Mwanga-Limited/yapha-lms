import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

export const SESSION_COOKIE = 'el_session';
export const PRIVILEGED = ['admin', 'teacher']; // AD-07: must use 2FA

const cookieOpts = () => ({
  httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/',
  maxAge: config.sessionHours * 3600 * 1000,
});

export function setSession(res, user) {
  const token = jwt.sign({ sub: user.id, tv: user.token_version, typ: 'session' }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
  res.cookie(SESSION_COOKIE, token, cookieOpts());
}
export function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, { ...cookieOpts(), maxAge: undefined });
}

export const signMfaToken = (user) =>
  jwt.sign({ sub: user.id, tv: user.token_version, typ: 'mfa' }, config.jwtSecret, { expiresIn: '10m' });

export function readMfaToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return p.typ === 'mfa' ? p : null;
  } catch { return null; }
}

/** Express middleware: attaches req.user when a valid, active session cookie is present. */
export async function loadUser(req, res, next) {
  req.user = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  try {
    const p = jwt.verify(token, config.jwtSecret);
    if (p.typ !== 'session') throw new Error('bad token');
    const { rows } = await query(`SELECT * FROM users WHERE id = $1`, [p.sub]);
    const u = rows[0];
    // Deactivated accounts and revoked sessions (token_version bumped) are signed out.
    if (!u || !u.is_active || u.token_version !== p.tv) clearSession(res);
    else req.user = u;
  } catch {
    clearSession(res);
  }
  next();
}

/** Public view of the current user. */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, phone: u.phone, bio: u.bio, expertise: u.expertise,
    photoUrl: u.photo_file_id ? `/api/files/${u.photo_file_id}` : null,
    role: u.role, isRoot: u.is_root, emailVerified: !!u.email_verified_at,
    totpEnabled: u.totp_enabled, hasPassword: !!u.password_hash, googleLinked: !!u.google_sub,
    createdAt: u.created_at,
  };
}

// ---- signed URLs for private files (lesson videos & downloads)
const sig = (id, exp) => crypto.createHmac('sha256', config.jwtSecret).update(`file:${id}:${exp}`).digest('base64url');

export function signedFileUrl(fileId, ttlSeconds = 4 * 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `/api/files/${fileId}?exp=${exp}&sig=${sig(fileId, exp)}`;
}
export function verifyFileSig(fileId, exp, s) {
  if (!exp || !s || Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(sig(fileId, exp));
  const given = Buffer.from(String(s));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
