import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, withScope } from '../db.js';
import { apiBase, currentTenant } from './tenant.js';

export const PLATFORM_COOKIE = 'el_platform';
export const PRIVILEGED = ['admin', 'teacher']; // AD-07: must use 2FA

/*
 * One session cookie per organisation (el_<slug>) plus one for the platform super admin (el_platform).
 * Each token carries the organisation id (tid) and is only accepted by that organisation, so a session
 * from one organisation is worthless in another. People can be signed in to several organisations at once.
 */
const cookieName = (tenant) => (tenant ? `el_${tenant.slug}` : PLATFORM_COOKIE);

const cookieOpts = () => ({
  httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/',
  maxAge: config.sessionHours * 3600 * 1000,
});

export function setSession(res, user) {
  const tenant = user.tenant_id ? currentTenant() : null;
  if (user.tenant_id && tenant?.id !== user.tenant_id) throw new Error('Session tenant mismatch');
  const token = jwt.sign({ sub: user.id, tid: user.tenant_id ?? null, tv: user.token_version, typ: 'session' },
    config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
  res.cookie(cookieName(tenant), token, cookieOpts());
}
export function clearSession(res, tenant = currentTenant()) {
  res.clearCookie(cookieName(tenant), { ...cookieOpts(), maxAge: undefined });
}

export const signMfaToken = (user) =>
  jwt.sign({ sub: user.id, tid: user.tenant_id ?? null, tv: user.token_version, typ: 'mfa' }, config.jwtSecret, { expiresIn: '10m' });

export function readMfaToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    if (p.typ !== 'mfa') return null;
    if ((p.tid ?? null) !== (currentTenant()?.id ?? null)) return null;   // 2FA token from another organisation
    return p;
  } catch { return null; }
}

function verifySession(token, tid) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return p.typ === 'session' && (p.tid ?? null) === tid ? p : null;
  } catch { return null; }
}

async function loadSuperAdmin(token) {
  const p = verifySession(token, null);
  if (!p) return null;
  return withScope({ bypass: true }, async () => {
    const { rows: [u] } = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id IS NULL AND role = 'superadmin'`, [p.sub]);
    return u && u.is_active && u.token_version === p.tv ? u : null;
  });
}

/**
 * Attach req.user for the current scope.
 * - In an organisation: its own session; failing that, a platform super admin, who acts as an Admin
 *   there (flagged isSuper, and audited as "superadmin").
 * - On the platform: only super admins.
 */
export async function loadUser(req, res) {
  req.user = null;
  const tenant = currentTenant();
  if (tenant) {
    const token = req.cookies?.[cookieName(tenant)];
    if (token) {
      const p = verifySession(token, tenant.id);
      const u = p ? (await query(`SELECT * FROM users WHERE id = $1`, [p.sub])).rows[0] : null;
      // Deactivated accounts and revoked sessions (token_version bumped) are signed out.
      if (u && u.is_active && u.token_version === p.tv) { req.user = u; return; }
      clearSession(res, tenant);
    }
    const platformToken = req.cookies?.[PLATFORM_COOKIE];
    if (platformToken) {
      const su = await loadSuperAdmin(platformToken);
      if (su) req.user = { ...su, role: 'admin', isSuper: true };
    }
    return;
  }
  const token = req.cookies?.[PLATFORM_COOKIE];
  if (!token) return;
  const su = await loadSuperAdmin(token);
  if (su) req.user = su;
  else clearSession(res, null);
}

/** Public view of the current user. */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, phone: u.phone, bio: u.bio, expertise: u.expertise,
    photoUrl: u.photo_file_id ? `${apiBase()}/files/${u.photo_file_id}` : null,
    role: u.isSuper ? 'superadmin' : u.role, isSuper: !!u.isSuper || u.role === 'superadmin',
    memberCode: u.member_code ?? null, tenantId: u.tenant_id ?? null,
    isRoot: u.is_root, emailVerified: !!u.email_verified_at,
    totpEnabled: u.totp_enabled, hasPassword: !!u.password_hash, googleLinked: !!u.google_sub,
    createdAt: u.created_at,
  };
}

// ---- signed URLs for private files (lesson videos & downloads)
const sig = (id, exp) => crypto.createHmac('sha256', config.jwtSecret).update(`file:${id}:${exp}`).digest('base64url');

export function signedFileUrl(fileId, ttlSeconds = 4 * 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${apiBase()}/files/${fileId}?exp=${exp}&sig=${sig(fileId, exp)}`;
}
export function verifyFileSig(fileId, exp, s) {
  if (!exp || !s || Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(sig(fileId, exp));
  const given = Buffer.from(String(s));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
