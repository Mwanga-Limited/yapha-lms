import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { config } from '../config.js';
import { db, query, tx } from '../db.js';
import { actionEndpoint, email, password, reqStr } from '../lib/actions.js';
import { audit } from '../lib/audit.js';
import { fail } from '../lib/errors.js';
import { emails } from '../lib/mailer.js';
import { notifyAdmins } from '../lib/notify.js';
import { PRIVILEGED, clearSession, publicUser, readMfaToken, setSession, signMfaToken } from '../lib/security.js';
import { consumeUserToken, issueUserToken, randomCode } from '../lib/tokens.js';
import { currentTenant, emailAllowed, publicTenant, settingsOf } from '../lib/tenant.js';

authenticator.options = { window: 1 };
const google = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;
const WINDOW = `interval '15 minutes'`;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', config.bcryptRounds); // keeps unknown-email logins as slow as real ones

async function recentCount(action, targetId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND target_id = $2 AND created_at > now() - ${WINDOW}`,
    [action, targetId],
  );
  return rows[0].n;
}

async function sendVerification(db, user) {
  const token = await issueUserToken(db, user.id, 'verify_email', 24 * 60);
  return () => emails.verify(user, token);
}

/** Two-step sign-in: always for Admin/Teacher (AD-07); for Students when the organisation requires it. */
const needsMfa = (user) => PRIVILEGED.includes(user.role) || (user.role === 'student' && settingsOf(currentTenant()).auth.studentMfa);

/** Joining rules of the organisation: open or invite-only, and allowed email domains. */
function checkCanJoin(email) {
  const tenant = currentTenant();
  if (settingsOf(tenant).access.signup === 'invite') fail(403, 'This organisation is invite-only. Ask an administrator to invite you.', { code: 'INVITE_ONLY' });
  if (!emailAllowed(tenant, email)) {
    fail(403, `Use your ${settingsOf(tenant).access.allowedDomains.map((d) => `@${d}`).join(' or ')} email address to join this organisation.`, { code: 'EMAIL_DOMAIN' });
  }
}

/** Second step for Admin/Teacher (AD-07) and, if configured, Students; otherwise a direct session. */
async function completeLogin(ctx, user, method) {
  if (needsMfa(user)) {
    let emailHint = null;
    if (!user.totp_enabled) {
      const code = randomCode();
      await issueUserToken(db, user.id, 'mfa_email', 10, code);
      ctx.after(() => emails.mfaCode(user, code));
      emailHint = user.email.replace(/^(.).*(@.*)$/, '$1•••$2');
    }
    return { mfa: { token: signMfaToken(user), method: user.totp_enabled ? 'totp' : 'email', emailHint } };
  }
  setSession(ctx.res, user);
  await audit(null, ctx, { action: 'auth.login', targetType: 'user', targetId: user.id, newValues: { method }, actor: user });
  return { user: publicUser(user) };
}

async function loadMfaUser(token) {
  const p = readMfaToken(token);
  if (!p) fail(401, 'Your sign-in session expired. Please sign in again.');
  const { rows } = await query(`SELECT * FROM users WHERE id = $1`, [p.sub]);
  const u = rows[0];
  if (!u || !u.is_active || u.token_version !== p.tv) fail(401, 'Please sign in again.');
  return u;
}

export const authRoutes = actionEndpoint({
  me: {
    auth: 'public',
    run: async ({ user }) => {
      const tenant = currentTenant();
      return { user: publicUser(user), tenant: publicTenant(tenant), googleClientId: settingsOf(tenant).auth.google ? (config.googleClientId || null) : null };
    },
  },

  register: {
    auth: 'public',
    schema: z.object({
      name: reqStr(120), email, password,
      joinAs: z.enum(['student', 'teacher']).default('student'),
      application: z.object({ bio: reqStr(2000, 20), expertise: reqStr(300), credentialUrl: z.string().trim().url().max(500).optional().or(z.literal('')) }).optional(),
    }),
    run: async (ctx) => {
      const d = ctx.data;
      if (d.joinAs === 'teacher' && !d.application) fail(400, 'Teacher sign-up needs a short profile and your area of expertise');
      checkCanJoin(d.email);
      const hash = await bcrypt.hash(d.password, config.bcryptRounds);
      const user = await tx(async (db) => {
        const exists = await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [d.email]);
        if (exists.rowCount) fail(409, 'An account with this email already exists');
        // AD-02: everyone registers as a Student; a Teacher sign-up creates an application (AD-08).
        const { rows } = await db.query(`INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING *`, [d.email, hash, d.name]);
        const u = rows[0];
        await audit(db, ctx, { action: 'auth.register', targetType: 'user', targetId: u.id, newValues: { email: u.email, joinAs: d.joinAs }, actor: u });
        if (d.joinAs === 'teacher') {
          const app = await db.query(
            `INSERT INTO teacher_applications (user_id, bio, expertise, credential_url) VALUES ($1,$2,$3,$4) RETURNING id`,
            [u.id, d.application.bio, d.application.expertise, d.application.credentialUrl || null],
          );
          await audit(db, ctx, { action: 'application.submit', targetType: 'teacher_application', targetId: app.rows[0].id, actor: u });
          await notifyAdmins(db, { type: 'application', title: 'New instructor application', body: `${u.name} wants to teach ${d.application.expertise}`, link: '/admin/applications' });
        }
        ctx.after(await sendVerification(db, u));
        return u;
      });
      setSession(ctx.res, user);
      await audit(null, ctx, { action: 'auth.login', targetType: 'user', targetId: user.id, newValues: { method: 'register' }, actor: user });
      return { user: publicUser(user) };
    },
  },

  login: {
    auth: 'public',
    schema: z.object({ email, password: z.string().min(1).max(200) }),
    run: async (ctx) => {
      const { email: em, password: pw } = ctx.data;
      if ((await recentCount('auth.login_failed', em)) >= config.loginMaxFailures) {
        await audit(null, ctx, { action: 'auth.login_blocked', targetType: 'email', targetId: em, actor: null });
        fail(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
      }
      const { rows } = await query(`SELECT * FROM users WHERE lower(email) = $1`, [em]);
      const u = rows[0];
      const ok = u?.password_hash ? await bcrypt.compare(pw, u.password_hash) : (await bcrypt.compare(pw, DUMMY_HASH), false);
      if (!ok) {
        await audit(null, ctx, { action: 'auth.login_failed', targetType: 'email', targetId: em, newValues: { reason: u ? 'bad_password' : 'unknown_email' }, actor: u ? u : { email: em } });
        fail(401, 'Invalid email or password');
      }
      if (!u.is_active) {
        await audit(null, ctx, { action: 'auth.login_failed', targetType: 'email', targetId: em, newValues: { reason: 'deactivated' }, actor: u });
        fail(403, 'This account has been deactivated. Contact support.');
      }
      return completeLogin(ctx, u, 'password');
    },
  },

  google: {
    auth: 'public',
    schema: z.object({ credential: z.string().min(10) }),
    run: async (ctx) => {
      if (!google || !settingsOf(currentTenant()).auth.google) fail(400, 'Google sign-in is not available for this organisation');
      let payload;
      try {
        payload = (await google.verifyIdToken({ idToken: ctx.data.credential, audience: config.googleClientId })).getPayload();
      } catch { fail(401, 'Google sign-in failed'); }
      if (!payload?.email || !payload.email_verified) fail(401, 'Your Google email is not verified');
      const em = payload.email.toLowerCase();
      const user = await tx(async (db) => {
        let { rows } = await db.query(`SELECT * FROM users WHERE google_sub = $1 OR lower(email) = $2 ORDER BY (google_sub = $1) DESC LIMIT 1`, [payload.sub, em]);
        let u = rows[0];
        if (!u) {
          checkCanJoin(em);
          ({ rows } = await db.query(
            `INSERT INTO users (email, name, google_sub, email_verified_at) VALUES ($1,$2,$3, now()) RETURNING *`,
            [em, payload.name || em.split('@')[0], payload.sub],
          ));
          u = rows[0];
          await audit(db, ctx, { action: 'auth.register', targetType: 'user', targetId: u.id, newValues: { email: em, method: 'google' }, actor: u });
        } else if (!u.google_sub || !u.email_verified_at) {
          ({ rows } = await db.query(`UPDATE users SET google_sub = coalesce(google_sub, $2), email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1 RETURNING *`, [u.id, payload.sub]));
          u = rows[0];
        }
        return u;
      });
      if (!user.is_active) {
        await audit(null, ctx, { action: 'auth.login_failed', targetType: 'email', targetId: em, newValues: { reason: 'deactivated', method: 'google' }, actor: user });
        fail(403, 'This account has been deactivated. Contact support.');
      }
      return completeLogin(ctx, user, 'google');
    },
  },

  verifyMfa: {
    auth: 'public',
    schema: z.object({ token: z.string(), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
    run: async (ctx) => {
      const u = await loadMfaUser(ctx.data.token);
      if ((await recentCount('auth.mfa_failed', u.id)) >= config.loginMaxFailures) fail(429, 'Too many wrong codes. Try again in 15 minutes.');
      let method = null;
      if (u.totp_enabled && u.totp_secret && authenticator.check(ctx.data.code, u.totp_secret)) method = 'totp';
      else if (await consumeUserToken(db, ctx.data.code, 'mfa_email', u.id)) method = 'email';
      if (!method) {
        await audit(null, ctx, { action: 'auth.mfa_failed', targetType: 'user', targetId: u.id, actor: u });
        fail(401, 'That code is not correct');
      }
      setSession(ctx.res, u);
      await audit(null, ctx, { action: 'auth.login', targetType: 'user', targetId: u.id, newValues: { method: `password+${method}` }, actor: u });
      return { user: publicUser(u) };
    },
  },

  sendMfaEmail: {
    auth: 'public',
    schema: z.object({ token: z.string() }),
    run: async (ctx) => {
      const u = await loadMfaUser(ctx.data.token);
      const code = randomCode();
      await issueUserToken(db, u.id, 'mfa_email', 10, code);
      ctx.after(() => emails.mfaCode(u, code));
      return { ok: true, emailHint: u.email.replace(/^(.).*(@.*)$/, '$1•••$2') };
    },
  },

  logout: {
    auth: 'public',
    run: async (ctx) => {
      if (ctx.user) await audit(null, ctx, { action: 'auth.logout', targetType: 'user', targetId: ctx.user.id });
      clearSession(ctx.res);
      return { ok: true };
    },
  },

  verifyEmail: {
    auth: 'public',
    schema: z.object({ token: z.string().min(10) }),
    run: async (ctx) => tx(async (db) => {
      const userId = await consumeUserToken(db, ctx.data.token, 'verify_email');
      if (!userId) fail(400, 'This verification link is invalid or has expired');
      const { rows } = await db.query(`UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1 RETURNING *`, [userId]);
      await audit(db, ctx, { action: 'auth.email_verified', targetType: 'user', targetId: userId, actor: rows[0] });
      return { ok: true };
    }),
  },

  resendVerification: {
    auth: 'user',
    run: async (ctx) => {
      if (ctx.user.email_verified_at) return { ok: true, alreadyVerified: true };
      ctx.after(await sendVerification(db, ctx.user));
      return { ok: true };
    },
  },

  requestPasswordReset: {
    auth: 'public',
    schema: z.object({ email }),
    run: async (ctx) => {
      const { rows } = await query(`SELECT * FROM users WHERE lower(email) = $1 AND is_active`, [ctx.data.email]);
      if (rows[0]) {
        const token = await issueUserToken(db, rows[0].id, 'reset_password', 60);
        ctx.after(() => emails.reset(rows[0], token));
        await audit(null, ctx, { action: 'auth.password_reset_requested', targetType: 'user', targetId: rows[0].id, actor: rows[0] });
      }
      return { ok: true }; // same answer whether or not the account exists
    },
  },

  resetPassword: {
    auth: 'public',
    schema: z.object({ token: z.string().min(10), password }),
    run: async (ctx) => {
      const hash = await bcrypt.hash(ctx.data.password, config.bcryptRounds);
      await tx(async (db) => {
        // A password-reset link, or an invitation link (which also confirms the email address).
        let userId = await consumeUserToken(db, ctx.data.token, 'reset_password');
        const invited = !userId && (userId = await consumeUserToken(db, ctx.data.token, 'invite'));
        if (!userId) fail(400, 'This link is invalid or has expired');
        // Bumping token_version signs out every existing session.
        const { rows } = await db.query(
          `UPDATE users SET password_hash = $2, token_version = token_version + 1,
                  email_verified_at = CASE WHEN $3 THEN coalesce(email_verified_at, now()) ELSE email_verified_at END
            WHERE id = $1 RETURNING *`, [userId, hash, !!invited]);
        await audit(db, ctx, { action: invited ? 'auth.invite_accepted' : 'auth.password_reset', targetType: 'user', targetId: userId, actor: rows[0] });
      });
      clearSession(ctx.res);
      return { ok: true };
    },
  },
});

