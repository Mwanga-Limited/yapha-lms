import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { actionEndpoint, id, password, reqStr, str } from '../lib/actions.js';
import { audit } from '../lib/audit.js';
import { computeProgress, findItem } from '../lib/content.js';
import { fail } from '../lib/errors.js';
import { notifyAdmins } from '../lib/notify.js';
import { publicUser, setSession } from '../lib/security.js';
import { learnerState } from '../lib/learning.js';

const profileFields = ['name', 'phone', 'bio', 'photo_file_id'];

export const accountRoutes = actionEndpoint({
  updateProfile: {
    auth: 'user',
    schema: z.object({
      name: reqStr(120),
      phone: str(40).regex(/^[+\d\s()-]*$/, 'Enter a valid phone number').optional().default(''),
      bio: str(2000).optional().default(''),
      photoFileId: id.nullable().optional(),
    }),
    run: async (ctx) => tx(async (db) => {
      const d = ctx.data;
      if (d.photoFileId) {
        const f = await db.query(`SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND purpose = 'photo'`, [d.photoFileId, ctx.user.id]);
        if (!f.rowCount) fail(400, 'Upload a profile photo first');
      }
      const before = Object.fromEntries(profileFields.map((k) => [k, ctx.user[k]]));
      const { rows } = await db.query(
        `UPDATE users SET name = $2, phone = nullif($3, ''), bio = nullif($4, ''), photo_file_id = $5 WHERE id = $1 RETURNING *`,
        [ctx.user.id, d.name, d.phone, d.bio, d.photoFileId === undefined ? ctx.user.photo_file_id : d.photoFileId]);
      const after = Object.fromEntries(profileFields.map((k) => [k, rows[0][k]]));
      await audit(db, ctx, { action: 'user.profile_update', targetType: 'user', targetId: ctx.user.id, oldValues: before, newValues: after });
      return { user: publicUser(rows[0]) };
    }),
  },

  changePassword: {
    auth: 'user',
    schema: z.object({ currentPassword: z.string().max(200).optional().default(''), newPassword: password }),
    run: async (ctx) => {
      const u = ctx.user;
      if (u.password_hash && !(await bcrypt.compare(ctx.data.currentPassword, u.password_hash))) fail(400, 'Your current password is not correct');
      const hash = await bcrypt.hash(ctx.data.newPassword, config.bcryptRounds);
      const { rows } = await query(`UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *`, [u.id, hash]);
      await audit(null, ctx, { action: 'user.password_change', targetType: 'user', targetId: u.id });
      setSession(ctx.res, rows[0]); // other sessions are signed out; keep this one
      return { ok: true };
    },
  },

  totpSetup: {
    auth: 'user',
    run: async (ctx) => {
      if (ctx.user.totp_enabled) fail(400, 'Authenticator app is already enabled');
      const secret = authenticator.generateSecret();
      
      console.log(new Date().toISOString(), authenticator.generate(secret));
      await query(`UPDATE users SET totp_secret = $2 WHERE id = $1 AND NOT totp_enabled`, [ctx.user.id, secret]);
      const uri = authenticator.keyuri(ctx.user.email, 'E-Learning', secret);
      return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
    },
  },

  totpEnable: {
    auth: 'user',
    schema: z.object({ code: z.string().trim().regex(/^\d{6}$/) }),
    run: async (ctx) => {
      const { rows: [u] } = await query(`SELECT * FROM users WHERE id = $1`, [ctx.user.id]);
      if (!u.totp_secret || !authenticator.check(ctx.data.code, u.totp_secret)) fail(400, 'That code is not correct. Check the time on your phone and try again.');
      const { rows } = await query(`UPDATE users SET totp_enabled = true WHERE id = $1 RETURNING *`, [u.id]);
      await audit(null, ctx, { action: 'user.2fa_enabled', targetType: 'user', targetId: u.id, newValues: { method: 'totp' } });
      return { user: publicUser(rows[0]) };
    },
  },

  totpDisable: {
    auth: 'user',
    schema: z.object({ code: z.string().trim().regex(/^\d{6}$/) }),
    run: async (ctx) => {
      const u = ctx.user;
      if (!u.totp_enabled || !authenticator.check(ctx.data.code, u.totp_secret)) fail(400, 'That code is not correct');
      // Admins/Teachers fall back to email codes, so 2FA stays mandatory (AD-07).
      const { rows } = await query(`UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1 RETURNING *`, [u.id]);
      await audit(null, ctx, { action: 'user.2fa_disabled', targetType: 'user', targetId: u.id, newValues: { fallback: 'email' } });
      return { user: publicUser(rows[0]) };
    },
  },

  notifications: {
    auth: 'user',
    schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    run: async (ctx) => {
      const [items, unread] = await Promise.all([
        query(`SELECT id, type, title, body, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [ctx.user.id, ctx.data.limit]),
        query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [ctx.user.id]),
      ]);
      return { items: items.rows, unread: unread.rows[0].n };
    },
  },

  markNotificationsRead: {
    auth: 'user',
    schema: z.object({ ids: z.array(id).max(200).optional() }),
    run: async (ctx) => {
      await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))`, [ctx.user.id, ctx.data.ids ?? null]);
      return { ok: true };
    },
  },

  applyTeacher: {
    auth: 'user',
    schema: z.object({ bio: reqStr(2000, 20), expertise: reqStr(300), credentialUrl: z.string().trim().url().max(500).optional().or(z.literal('')) }),
    run: async (ctx) => tx(async (db) => {
      if (ctx.user.role !== 'student') fail(400, 'You already have teaching access');
      const pending = await db.query(`SELECT 1 FROM teacher_applications WHERE user_id = $1 AND status = 'pending'`, [ctx.user.id]);
      if (pending.rowCount) fail(409, 'You already have an application waiting for review');
      const { rows } = await db.query(
        `INSERT INTO teacher_applications (user_id, bio, expertise, credential_url) VALUES ($1,$2,$3,$4) RETURNING *`,
        [ctx.user.id, ctx.data.bio, ctx.data.expertise, ctx.data.credentialUrl || null]);
      await audit(db, ctx, { action: 'application.submit', targetType: 'teacher_application', targetId: rows[0].id, newValues: { expertise: ctx.data.expertise } });
      await notifyAdmins(db, { type: 'application', title: 'New instructor application', body: `${ctx.user.name} wants to teach ${ctx.data.expertise}`, link: '/admin/applications' });
      return { application: rows[0] };
    }),
  },

  myApplications: {
    auth: 'user',
    run: async (ctx) => {
      const { rows } = await query(`SELECT id, bio, expertise, credential_url, status, decision_reason, reviewed_at, created_at FROM teacher_applications WHERE user_id = $1 ORDER BY created_at DESC`, [ctx.user.id]);
      return { applications: rows };
    },
  },

  /** Learner dashboard: my courses, progress, resume point, certificates. */
  dashboard: {
    auth: 'student',
    run: async (ctx) => {
      const { rows } = await query(
        `SELECT e.id AS enrollment_id, e.enrolled_at, e.completed_at, e.last_item_id, e.last_accessed_at,
                c.id, c.title, c.summary, c.category, c.level, c.thumbnail_file_id, c.status, v.content,
                u.name AS teacher_name, cert.code AS certificate_code, cert.revoked_at AS certificate_revoked_at
           FROM enrollments e
           JOIN courses c ON c.id = e.course_id
           JOIN users u ON u.id = c.teacher_id
           LEFT JOIN course_versions v ON v.id = c.live_version_id
           LEFT JOIN certificates cert ON cert.enrollment_id = e.id
          WHERE e.user_id = $1 AND e.status = 'active'
          ORDER BY coalesce(e.last_accessed_at, e.enrolled_at) DESC`, [ctx.user.id]);
      const courses = [];
      for (const r of rows) {
        const st = await learnerState({ query }, r.enrollment_id);
        const progress = computeProgress(r.content, st.completed, st.passed);
        const last = r.last_item_id ? findItem(r.content, r.last_item_id) : null;
        courses.push({
          id: r.id, title: r.title, summary: r.summary, category: r.category, level: r.level, teacherName: r.teacher_name,
          thumbnailUrl: r.thumbnail_file_id ? `/api/files/${r.thumbnail_file_id}` : null, courseStatus: r.status,
          enrolledAt: r.enrolled_at, completedAt: r.completed_at, lastAccessedAt: r.last_accessed_at,
          resume: last ? { id: last.id, title: last.title, kind: last.kind } : null,
          progress: { percent: progress.percent, done: progress.done, total: progress.total },
          certificate: r.certificate_code ? { code: r.certificate_code, revoked: !!r.certificate_revoked_at } : null,
        });
      }
      return { courses };
    },
  },
});
