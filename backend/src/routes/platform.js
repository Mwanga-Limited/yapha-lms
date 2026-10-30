import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { asTenant, db, query, runInContext, tx } from '../db.js';
import { actionEndpoint, email, id, page, password, reqStr, str } from '../lib/actions.js';
import { audit } from '../lib/audit.js';
import { fail, notFound } from '../lib/errors.js';
import { emails } from '../lib/mailer.js';
import { clearSession, publicUser, readMfaToken, setSession, signMfaToken } from '../lib/security.js';
import { RESERVED_SLUGS, SLUG_RE, defaultSettings, publicTenant, settingsOf, settingsSchema } from '../lib/tenant.js';
import { consumeUserToken, issueUserToken, randomCode } from '../lib/tokens.js';

/*
 * POST /api/platform — the super admin console. Every request here runs with app.bypass = on, so the
 * super admin can see all organisations. Each query below therefore says explicitly whether it wants
 * platform rows (tenant_id IS NULL) or a particular organisation's rows.
 * Super admin accounts are created only by the seed script (npm run seed:superadmin).
 */
const SUPER = ['superadmin'];
const WINDOW = `interval '15 minutes'`;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', config.bcryptRounds);
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const hint = (em) => em.replace(/^(.).*(@.*)$/, '$1•••$2');

async function recentPlatformCount(action, targetId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id IS NULL AND action = $1 AND target_id = $2 AND created_at > now() - ${WINDOW}`,
    [action, targetId]);
  return rows[0].n;
}

async function loadMfaSuper(token) {
  const p = readMfaToken(token);
  if (!p) fail(401, 'Your sign-in session expired. Please sign in again.');
  const { rows: [u] } = await query(`SELECT * FROM users WHERE id = $1 AND tenant_id IS NULL AND role = 'superadmin'`, [p.sub]);
  if (!u || !u.is_active || u.token_version !== p.tv) fail(401, 'Please sign in again.');
  return u;
}

const TENANT_COUNTS = `
  (SELECT count(*) FROM users u WHERE u.tenant_id = t.id)::int AS members,
  (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.role = 'student')::int AS students,
  (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.role = 'teacher')::int AS teachers,
  (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.role = 'admin')::int AS admins,
  (SELECT count(*) FROM courses c WHERE c.tenant_id = t.id AND c.status = 'published')::int AS published_courses,
  (SELECT count(*) FROM course_versions v WHERE v.tenant_id = t.id AND v.status = 'in_review')::int AS awaiting_review,
  (SELECT count(*) FROM enrollments e WHERE e.tenant_id = t.id AND e.status = 'active')::int AS enrollments,
  (SELECT count(*) FROM enrollments e WHERE e.tenant_id = t.id AND e.completed_at IS NOT NULL)::int AS completions,
  (SELECT count(*) FROM certificates x WHERE x.tenant_id = t.id AND x.revoked_at IS NULL)::int AS certificates,
  (SELECT max(a.created_at) FROM audit_logs a WHERE a.tenant_id = t.id) AS last_activity`;

const tenantRow = (t) => ({
  id: t.id, slug: t.slug, name: t.name, status: t.status, createdAt: t.created_at, updatedAt: t.updated_at,
  displayName: settingsOf(t).branding.displayName || t.name,
  counts: t.members === undefined ? undefined : {
    members: t.members, students: t.students, teachers: t.teachers, admins: t.admins, publishedCourses: t.published_courses,
    awaitingReview: t.awaiting_review, enrollments: t.enrollments, completions: t.completions, certificates: t.certificates,
  },
  lastActivity: t.last_activity ?? null,
});

function auditFilters(d) {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (d.tenantId === 'platform') where.push('a.tenant_id IS NULL');
  else if (d.tenantId) add('a.tenant_id = ?::uuid', d.tenantId);
  if (d.actor) add(`a.actor_email ILIKE '%'||?||'%'`, likeEscape(d.actor));
  if (d.action) add('a.action = ?', d.action);
  if (d.from) add('a.created_at >= ?::date', d.from);
  if (d.to) add('a.created_at < (?::date + 1)', d.to);
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}
const auditSchema = z.object({
  tenantId: z.union([z.literal('platform'), z.literal(''), id]).default(''),
  actor: str(254).default(''), action: str(80).default(''),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  page,
});
const csvCell = (v) => {
  if (v == null) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function getTenant(tenantId) {
  const { rows: [t] } = await query(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
  if (!t) notFound('Organisation');
  return t;
}

/** Create a user in an organisation and email them an invitation link (used for the organisation's Admins). */
async function inviteIntoTenant(ctx, tenant, { name, email: em, role, isRoot = false }) {
  return asTenant(tenant, async () => {
    const exists = await query(`SELECT 1 FROM users WHERE lower(email) = $1`, [em]);
    if (exists.rowCount) fail(409, 'Someone with this email is already a member of this organisation');
    const { rows: [u] } = await query(
      `INSERT INTO users (tenant_id, email, name, role, is_root) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [tenant.id, em, name, role, isRoot]);
    const token = await issueUserToken(db, u.id, 'invite', 7 * 24 * 60);
    await audit(db, ctx, { action: 'user.invite', targetType: 'user', targetId: u.id, newValues: { email: em, role, firstAdmin: isRoot, by: 'platform' } });
    ctx.after(() => runInContext({ tenant }, () => emails.invite(u, token, 'The platform administrator')));
    return u;
  });
}

export const platformRoutes = actionEndpoint({
  // ------------------------------------------------------------- super admin sign-in (always two-step)
  me: { auth: 'public', run: async ({ user }) => ({ user: publicUser(user) }) },

  login: {
    auth: 'public',
    schema: z.object({ email, password: z.string().min(1).max(200) }),
    run: async (ctx) => {
      const { email: em, password: pw } = ctx.data;
      if ((await recentPlatformCount('platform.login_failed', em)) >= config.loginMaxFailures) {
        fail(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
      }
      const { rows: [u] } = await query(`SELECT * FROM users WHERE tenant_id IS NULL AND role = 'superadmin' AND lower(email) = $1`, [em]);
      const ok = u?.password_hash ? await bcrypt.compare(pw, u.password_hash) : (await bcrypt.compare(pw, DUMMY_HASH), false);
      if (!ok || !u.is_active) {
        await audit(null, ctx, { action: 'platform.login_failed', targetType: 'email', targetId: em, actor: u ?? { email: em } });
        fail(401, 'Invalid email or password');
      }
      let emailHint = null;
      if (!u.totp_enabled) {
        const code = randomCode();
        await issueUserToken(db, u.id, 'mfa_email', 10, code);
        ctx.after(() => emails.mfaCode(u, code));
        emailHint = hint(u.email);
      }
      return { mfa: { token: signMfaToken(u), method: u.totp_enabled ? 'totp' : 'email', emailHint } };
    },
  },

  verifyMfa: {
    auth: 'public',
    schema: z.object({ token: z.string(), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
    run: async (ctx) => {
      const u = await loadMfaSuper(ctx.data.token);
      if ((await recentPlatformCount('platform.mfa_failed', u.id)) >= config.loginMaxFailures) fail(429, 'Too many wrong codes. Try again in 15 minutes.');
      let method = null;
      if (u.totp_enabled && u.totp_secret && authenticator.check(ctx.data.code, u.totp_secret)) method = 'totp';
      else if (await consumeUserToken(db, ctx.data.code, 'mfa_email', u.id)) method = 'email';
      if (!method) {
        await audit(null, ctx, { action: 'platform.mfa_failed', targetType: 'user', targetId: u.id, actor: u });
        fail(401, 'That code is not correct');
      }
      setSession(ctx.res, u);
      await audit(null, ctx, { action: 'platform.login', targetType: 'user', targetId: u.id, newValues: { method: `password+${method}` }, actor: u });
      return { user: publicUser(u) };
    },
  },

  sendMfaEmail: {
    auth: 'public',
    schema: z.object({ token: z.string() }),
    run: async (ctx) => {
      const u = await loadMfaSuper(ctx.data.token);
      const code = randomCode();
      await issueUserToken(db, u.id, 'mfa_email', 10, code);
      ctx.after(() => emails.mfaCode(u, code));
      return { ok: true, emailHint: hint(u.email) };
    },
  },

  logout: {
    auth: 'public',
    run: async (ctx) => {
      if (ctx.user) await audit(null, ctx, { action: 'platform.logout', targetType: 'user', targetId: ctx.user.id });
      clearSession(ctx.res, null);
      return { ok: true };
    },
  },

  changePassword: {
    auth: SUPER,
    schema: z.object({ currentPassword: z.string().max(200), newPassword: password }),
    run: async (ctx) => {
      if (!(await bcrypt.compare(ctx.data.currentPassword, ctx.user.password_hash || DUMMY_HASH))) fail(400, 'Your current password is not correct');
      const hash = await bcrypt.hash(ctx.data.newPassword, config.bcryptRounds);
      const { rows: [u] } = await query(`UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *`, [ctx.user.id, hash]);
      await audit({ query }, ctx, { action: 'platform.password_change', targetType: 'user', targetId: u.id });
      setSession(ctx.res, u);
      return { ok: true };
    },
  },

  totpSetup: {
    auth: SUPER,
    run: async (ctx) => {
      if (ctx.user.totp_enabled) fail(400, 'Authenticator app is already enabled');
      const secret = authenticator.generateSecret();
      await query(`UPDATE users SET totp_secret = $2 WHERE id = $1`, [ctx.user.id, secret]);
      const uri = authenticator.keyuri(ctx.user.email, 'E-Learning platform', secret);
      return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
    },
  },

  totpEnable: {
    auth: SUPER,
    schema: z.object({ code: z.string().trim().regex(/^\d{6}$/) }),
    run: async (ctx) => {
      const { rows: [u] } = await query(`SELECT * FROM users WHERE id = $1`, [ctx.user.id]);
      if (!u.totp_secret || !authenticator.check(ctx.data.code, u.totp_secret)) fail(400, 'That code is not correct. Check the time on your phone and computer.');
      const { rows: [n] } = await query(`UPDATE users SET totp_enabled = true WHERE id = $1 RETURNING *`, [u.id]);
      await audit({ query }, ctx, { action: 'platform.2fa_enabled', targetType: 'user', targetId: u.id });
      return { user: publicUser(n) };
    },
  },

  // ------------------------------------------------------------- overview across all organisations
  stats: {
    auth: SUPER,
    run: async () => {
      const { rows: [s] } = await query(`SELECT
        (SELECT count(*) FROM tenants)::int AS tenants,
        (SELECT count(*) FROM tenants WHERE status = 'active')::int AS active_tenants,
        (SELECT count(*) FROM users WHERE tenant_id IS NOT NULL)::int AS members,
        (SELECT count(*) FROM users WHERE role = 'student')::int AS students,
        (SELECT count(*) FROM users WHERE role = 'teacher')::int AS teachers,
        (SELECT count(*) FROM courses WHERE status = 'published')::int AS published_courses,
        (SELECT count(*) FROM enrollments WHERE status = 'active')::int AS enrollments,
        (SELECT count(*) FROM enrollments WHERE completed_at IS NOT NULL)::int AS completions,
        (SELECT count(*) FROM certificates WHERE revoked_at IS NULL)::int AS certificates,
        (SELECT count(*) FROM course_versions WHERE status = 'in_review')::int AS awaiting_review`);
      const { rows } = await query(`SELECT t.*, ${TENANT_COUNTS} FROM tenants t ORDER BY t.created_at`);
      return { stats: s, tenants: rows.map(tenantRow) };
    },
  },

  // ------------------------------------------------------------- organisations
  tenants: {
    auth: SUPER,
    schema: z.object({ q: str(100).default(''), status: z.enum(['', 'active', 'suspended']).default('') }),
    run: async ({ data }) => {
      const { rows } = await query(
        `SELECT t.*, ${TENANT_COUNTS} FROM tenants t
          WHERE ($1 = '' OR t.name ILIKE '%'||$1||'%' OR t.slug ILIKE '%'||$1||'%') AND ($2 = '' OR t.status = $2)
          ORDER BY t.name`, [likeEscape(data.q), data.status]);
      return { tenants: rows.map(tenantRow) };
    },
  },

  tenant: {
    auth: SUPER,
    schema: z.object({ id }),
    run: async ({ data }) => {
      const { rows: [t] } = await query(`SELECT t.*, ${TENANT_COUNTS} FROM tenants t WHERE t.id = $1`, [data.id]);
      if (!t) notFound('Organisation');
      const { rows: admins } = await query(
        `SELECT id, name, email, member_code, is_root, is_active, password_hash IS NOT NULL AS activated, created_at
           FROM users WHERE tenant_id = $1 AND role = 'admin' ORDER BY is_root DESC, created_at`, [t.id]);
      const { rows: activity } = await query(
        `SELECT id, created_at, actor_email, actor_role, action, target_type FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 15`, [t.id]);
      return {
        tenant: tenantRow(t), settings: settingsOf(t), public: publicTenant(t),
        admins: admins.map((a) => ({ id: a.id, name: a.name, email: a.email, memberCode: a.member_code, isRoot: a.is_root, isActive: a.is_active, activated: a.activated, createdAt: a.created_at })),
        activity,
      };
    },
  },

  createTenant: {
    auth: SUPER,
    schema: z.object({
      name: reqStr(120),
      slug: z.string().trim().toLowerCase().regex(SLUG_RE, 'Use 2–40 lowercase letters, numbers and dashes (e.g. acme-academy)'),
      adminName: reqStr(120),
      adminEmail: email,
      settings: settingsSchema.optional(),
    }),
    run: async (ctx) => tx(async () => {
      const d = ctx.data;
      if (RESERVED_SLUGS.has(d.slug)) fail(400, `"${d.slug}" is reserved. Choose another web address.`);
      const taken = await query(`SELECT 1 FROM tenants WHERE slug = $1`, [d.slug]);
      if (taken.rowCount) fail(409, 'Another organisation already uses this web address');
      const { rows: [t] } = await query(`INSERT INTO tenants (slug, name, settings) VALUES ($1,$2,$3) RETURNING *`,
        [d.slug, d.name, d.settings ?? defaultSettings()]);
      await audit({ query }, ctx, { action: 'platform.tenant_create', targetType: 'tenant', targetId: t.id, newValues: { name: t.name, slug: t.slug } });
      // AD-01 per organisation: its first Admin is created together with it and is protected (AD-04).
      const admin = await inviteIntoTenant(ctx, t, { name: d.adminName, email: d.adminEmail, role: 'admin', isRoot: true });
      return { tenant: tenantRow(t), admin: { id: admin.id, email: admin.email, memberCode: admin.member_code } };
    }),
  },

  updateTenant: {
    auth: SUPER,
    schema: z.object({ id, name: reqStr(120).optional(), status: z.enum(['active', 'suspended']).optional(), settings: settingsSchema.optional() }),
    run: async (ctx) => {
      const d = ctx.data;
      const t = await getTenant(d.id);
      const { rows: [u] } = await query(
        `UPDATE tenants SET name = coalesce($2, name), status = coalesce($3, status), settings = coalesce($4, settings), updated_at = now()
          WHERE id = $1 RETURNING *`, [t.id, d.name ?? null, d.status ?? null, d.settings ?? null]);
      await audit({ query }, ctx, { action: d.status && d.status !== t.status ? `platform.tenant_${d.status === 'suspended' ? 'suspend' : 'activate'}` : 'platform.tenant_update',
        targetType: 'tenant', targetId: t.id,
        oldValues: { name: t.name, status: t.status, settings: settingsOf(t) }, newValues: { name: u.name, status: u.status, settings: settingsOf(u) } });
      return { tenant: tenantRow(u), settings: settingsOf(u) };
    },
  },

  /** Add another Admin to an organisation (e.g. when its Admins have left). */
  addTenantAdmin: {
    auth: SUPER,
    schema: z.object({ tenantId: id, name: reqStr(120), email }),
    run: async (ctx) => tx(async () => {
      const t = await getTenant(ctx.data.tenantId);
      const u = await inviteIntoTenant(ctx, t, { name: ctx.data.name, email: ctx.data.email, role: 'admin' });
      return { admin: { id: u.id, email: u.email, memberCode: u.member_code } };
    }),
  },

  // ------------------------------------------------------------- cross-organisation views
  users: {
    auth: SUPER,
    schema: z.object({ q: str(100).default(''), tenantId: z.union([z.literal(''), id]).default(''), role: z.enum(['', 'student', 'teacher', 'admin']).default(''), page }),
    run: async ({ data }) => {
      const params = [likeEscape(data.q), data.tenantId, data.role, 25, (data.page - 1) * 25];
      const where = `u.tenant_id IS NOT NULL AND ($1 = '' OR u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%' OR u.member_code ILIKE '%'||$1||'%')
                     AND ($2 = '' OR u.tenant_id = nullif($2, '')::uuid) AND ($3 = '' OR u.role::text = $3)`;
      const [list, total] = await Promise.all([
        query(`SELECT u.*, t.name AS tenant_name, t.slug AS tenant_slug FROM users u JOIN tenants t ON t.id = u.tenant_id
                WHERE ${where} ORDER BY u.created_at DESC LIMIT $4 OFFSET $5`, params),
        query(`SELECT count(*)::int AS n FROM users u WHERE ${where}`, params.slice(0, 3)),
      ]);
      return {
        users: list.rows.map((u) => ({
          id: u.id, name: u.name, email: u.email, role: u.role, memberCode: u.member_code, isRoot: u.is_root, isActive: u.is_active,
          emailVerified: !!u.email_verified_at, createdAt: u.created_at, tenant: { id: u.tenant_id, name: u.tenant_name, slug: u.tenant_slug },
        })),
        total: total.rows[0].n, pageSize: 25,
      };
    },
  },

  audit: {
    auth: SUPER,
    schema: auditSchema,
    run: async ({ data }) => {
      const f = auditFilters(data);
      const n = f.params.length;
      const [list, total, actions] = await Promise.all([
        query(`SELECT a.*, t.name AS tenant_name, t.slug AS tenant_slug FROM audit_logs a LEFT JOIN tenants t ON t.id = a.tenant_id
                ${f.where} ORDER BY a.created_at DESC, a.id DESC LIMIT $${n + 1} OFFSET $${n + 2}`, [...f.params, 50, (data.page - 1) * 50]),
        query(`SELECT count(*)::int AS n FROM audit_logs a ${f.where}`, f.params),
        query(`SELECT DISTINCT action FROM audit_logs ORDER BY action`),
      ]);
      return { entries: list.rows, total: total.rows[0].n, pageSize: 50, actions: actions.rows.map((r) => r.action) };
    },
  },

  auditCsv: {
    auth: SUPER,
    schema: auditSchema,
    run: async (ctx) => {
      const f = auditFilters(ctx.data);
      const { rows } = await query(`SELECT a.*, t.slug AS tenant_slug FROM audit_logs a LEFT JOIN tenants t ON t.id = a.tenant_id
        ${f.where} ORDER BY a.created_at DESC, a.id DESC LIMIT 50000`, f.params);
      const cols = ['id', 'created_at', 'tenant_slug', 'actor_email', 'actor_role', 'actor_id', 'action', 'target_type', 'target_id', 'old_values', 'new_values', 'ip', 'user_agent'];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(c === 'created_at' ? new Date(r[c]).toISOString() : (c === 'tenant_slug' ? (r[c] ?? 'platform') : r[c]))).join(','))].join('\r\n');
      await audit(null, ctx, { action: 'platform.audit_export', targetType: 'audit_log', newValues: { filters: ctx.data, rows: rows.length } });
      return { csv, filename: `platform-audit-${new Date().toISOString().slice(0, 10)}.csv` };
    },
  },
});
