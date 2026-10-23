import { z } from 'zod';
import { pool, query, tx } from '../db.js';
import { actionEndpoint, id, page, reqStr, str } from '../lib/actions.js';
import { audit } from '../lib/audit.js';
import { lessonsOf, quizzesOf } from '../lib/content.js';
import { fail, notFound } from '../lib/errors.js';
import { emails } from '../lib/mailer.js';
import { notify } from '../lib/notify.js';
import { publicUser } from '../lib/security.js';
import { courseMeta } from './courses.js';

const ADMIN = ['admin'];
const PAGE = 25;
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Record a blocked attempt (AD-06) outside the transaction so it survives the rollback, then refuse. */
async function blocked(ctx, action, target, reason, attempted) {
  await audit(null, ctx, { action, targetType: 'user', targetId: target.id, oldValues: { role: target.role, isActive: target.is_active }, newValues: { attempted, reason } });
  fail(403, reason);
}

function auditFilters(d) {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (d.actor) add(`(a.actor_email ILIKE '%'||?||'%')`, likeEscape(d.actor));
  if (d.action) add(`a.action = ?`, d.action);
  if (d.from) add(`a.created_at >= ?::date`, d.from);
  if (d.to) add(`a.created_at < (?::date + 1)`, d.to);
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}
const auditSchema = z.object({
  actor: str(254).default(''), action: str(80).default(''),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  page,
});

const csvCell = (v) => {
  if (v == null) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;           // neutralise spreadsheet formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const adminRoutes = actionEndpoint({
  stats: {
    auth: ADMIN,
    run: async () => {
      const { rows: [s] } = await query(`SELECT
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM users WHERE role = 'student') AS students,
        (SELECT count(*) FROM users WHERE role = 'teacher') AS teachers,
        (SELECT count(*) FROM users WHERE role = 'admin') AS admins,
        (SELECT count(*) FROM users WHERE NOT is_active) AS deactivated,
        (SELECT count(*) FROM enrollments WHERE status = 'active') AS enrollments,
        (SELECT count(*) FROM enrollments WHERE completed_at IS NOT NULL) AS completions,
        (SELECT count(*) FROM certificates WHERE revoked_at IS NULL) AS certificates,
        (SELECT count(*) FROM courses WHERE status = 'published') AS published_courses,
        (SELECT count(*) FROM course_versions WHERE status = 'in_review') AS awaiting_review,
        (SELECT count(*) FROM teacher_applications WHERE status = 'pending') AS pending_applications`);
      const { rows: recent } = await query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day,
                (SELECT count(*) FROM enrollments e WHERE e.enrolled_at::date = d) AS enrollments,
                (SELECT count(*) FROM enrollments e WHERE e.completed_at::date = d) AS completions
           FROM generate_series(current_date - 13, current_date, interval '1 day') d ORDER BY d`);
      return { stats: s, daily: recent };
    },
  },

  // ------------------------------------------------------------- course approval (CR-02, CR-03, CR-04)
  reviewQueue: {
    auth: ADMIN,
    run: async () => {
      const { rows } = await query(
        `SELECT v.id AS version_id, v.version_no, v.submitted_at, v.content, c.*, u.name AS teacher_name, u.email AS teacher_email,
                (SELECT count(*) FROM course_reviews r WHERE r.course_id = c.id AND r.decision = 'rejected') AS rejections
           FROM course_versions v JOIN courses c ON c.id = v.course_id JOIN users u ON u.id = c.teacher_id
          WHERE v.status = 'in_review' ORDER BY v.submitted_at`);
      return {
        queue: rows.map((r) => ({
          versionId: r.version_id, versionNo: r.version_no, submittedAt: r.submitted_at, isRevision: !!r.live_version_id,
          course: courseMeta(r), teacherName: r.teacher_name, teacherEmail: r.teacher_email, rejections: r.rejections,
          lessonCount: lessonsOf(r.content).length, quizCount: quizzesOf(r.content).length,
        })),
      };
    },
  },

  approveCourse: {
    auth: ADMIN,
    schema: z.object({ versionId: id, note: str(2000).default('') }),
    run: async (ctx) => tx(async (db) => {
      const { rows: [v] } = await db.query(`SELECT * FROM course_versions WHERE id = $1 FOR UPDATE`, [ctx.data.versionId]);
      if (!v) notFound('Version');
      if (v.status !== 'in_review') fail(409, 'This version is not waiting for review');
      const { rows: [c] } = await db.query(`SELECT * FROM courses WHERE id = $1 FOR UPDATE`, [v.course_id]);
      const isRevision = !!c.live_version_id;
      if (isRevision) await db.query(`UPDATE course_versions SET status = 'superseded', updated_at = now() WHERE id = $1`, [c.live_version_id]);
      await db.query(`UPDATE course_versions SET status = 'approved', reviewed_at = now(), reviewed_by = $2, updated_at = now() WHERE id = $1`, [v.id, ctx.user.id]);
      // A revision replaces the live version; the course keeps its published/unpublished state.
      const newStatus = isRevision ? c.status : 'approved';
      await db.query(`UPDATE courses SET live_version_id = $2, draft_version_id = NULL, status = $3, updated_at = now() WHERE id = $1`, [c.id, v.id, newStatus]);
      await db.query(`INSERT INTO course_reviews (course_id, version_id, version_no, admin_id, decision, reason) VALUES ($1,$2,$3,$4,'approved', nullif($5, ''))`,
        [c.id, v.id, v.version_no, ctx.user.id, ctx.data.note]);
      await audit(db, ctx, { action: 'course.approve', targetType: 'course', targetId: c.id, oldValues: { status: c.status }, newValues: { status: newStatus, versionNo: v.version_no, revision: isRevision } });
      await notify(db, c.teacher_id, { type: 'course', title: `Approved: ${c.title}`, body: isRevision ? 'Your changes are now live.' : 'You can now publish it.', link: `/teach/courses/${c.id}` });
      const { rows: [t] } = await db.query(`SELECT * FROM users WHERE id = $1`, [c.teacher_id]);
      ctx.after(() => emails.courseDecision(t, { ...c, live: isRevision }, true));
      return { ok: true };
    }),
  },

  rejectCourse: {
    auth: ADMIN,
    schema: z.object({ versionId: id, reason: reqStr(2000, 5) }),
    run: async (ctx) => tx(async (db) => {
      const { rows: [v] } = await db.query(`SELECT * FROM course_versions WHERE id = $1 FOR UPDATE`, [ctx.data.versionId]);
      if (!v) notFound('Version');
      if (v.status !== 'in_review') fail(409, 'This version is not waiting for review');
      const { rows: [c] } = await db.query(`SELECT * FROM courses WHERE id = $1 FOR UPDATE`, [v.course_id]);
      await db.query(`UPDATE course_versions SET status = 'rejected', reviewed_at = now(), reviewed_by = $2, updated_at = now() WHERE id = $1`, [v.id, ctx.user.id]);
      if (!c.live_version_id) await db.query(`UPDATE courses SET status = 'rejected', updated_at = now() WHERE id = $1`, [c.id]);
      await db.query(`INSERT INTO course_reviews (course_id, version_id, version_no, admin_id, decision, reason) VALUES ($1,$2,$3,$4,'rejected',$5)`,
        [c.id, v.id, v.version_no, ctx.user.id, ctx.data.reason]);
      await audit(db, ctx, { action: 'course.reject', targetType: 'course', targetId: c.id, oldValues: { status: c.status }, newValues: { versionNo: v.version_no, reason: ctx.data.reason } });
      await notify(db, c.teacher_id, { type: 'course', title: `Changes requested: ${c.title}`, body: ctx.data.reason, link: `/teach/courses/${c.id}` });
      const { rows: [t] } = await db.query(`SELECT * FROM users WHERE id = $1`, [c.teacher_id]);
      ctx.after(() => emails.courseDecision(t, c, false, ctx.data.reason));
      return { ok: true };
    }),
  },

  courses: {
    auth: ADMIN,
    schema: z.object({ q: str(100).default(''), status: str(20).default(''), page }),
    run: async ({ data }) => {
      const params = [likeEscape(data.q), data.status, PAGE, (data.page - 1) * PAGE];
      const where = `($1 = '' OR c.title ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%') AND ($2 = '' OR c.status::text = $2)`;
      const [list, total] = await Promise.all([
        query(`SELECT c.*, u.name AS teacher_name, d.status AS draft_status,
                      (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id) AS learners
                 FROM courses c JOIN users u ON u.id = c.teacher_id LEFT JOIN course_versions d ON d.id = c.draft_version_id
                WHERE ${where} ORDER BY c.updated_at DESC LIMIT $3 OFFSET $4`, params),
        query(`SELECT count(*)::int AS n FROM courses c JOIN users u ON u.id = c.teacher_id WHERE ${where}`, params.slice(0, 2)),
      ]);
      return { courses: list.rows.map((c) => ({ ...courseMeta(c), teacherName: c.teacher_name, learners: c.learners, revisionStatus: c.draft_status })), total: total.rows[0].n, pageSize: PAGE };
    },
  },

  // ------------------------------------------------------------- teacher applications
  applications: {
    auth: ADMIN,
    schema: z.object({ status: z.enum(['pending', 'approved', 'declined', 'all']).default('pending') }),
    run: async ({ data }) => {
      const { rows } = await query(
        `SELECT a.*, u.name, u.email, u.role, u.email_verified_at, r.name AS reviewer_name
           FROM teacher_applications a JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.reviewed_by
          WHERE ($1 = 'all' OR a.status = $1) ORDER BY a.created_at DESC LIMIT 200`, [data.status]);
      return { applications: rows };
    },
  },

  decideApplication: {
    auth: ADMIN,
    schema: z.object({ id, decision: z.enum(['approve', 'decline']), reason: str(2000).default('') }),
    run: async (ctx) => tx(async (db) => {
      const d = ctx.data;
      if (d.decision === 'decline' && d.reason.length < 5) fail(400, 'Give the applicant a reason (at least 5 characters)');
      const { rows: [a] } = await db.query(`SELECT * FROM teacher_applications WHERE id = $1 FOR UPDATE`, [d.id]);
      if (!a) notFound('Application');
      if (a.status !== 'pending') fail(409, 'This application was already decided');
      const status = d.decision === 'approve' ? 'approved' : 'declined';
      await db.query(`UPDATE teacher_applications SET status = $2, decision_reason = nullif($3, ''), reviewed_by = $4, reviewed_at = now() WHERE id = $1`, [a.id, status, d.reason, ctx.user.id]);
      const { rows: [u] } = await db.query(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [a.user_id]);
      await audit(db, ctx, { action: `application.${status === 'approved' ? 'approve' : 'decline'}`, targetType: 'teacher_application', targetId: a.id, newValues: { user: u.email, reason: d.reason || null } });
      if (status === 'approved' && u.role === 'student') {
        // AD-08: becoming a Teacher via an Admin decision. Bump token_version so the next sign-in uses 2FA (AD-07).
        await db.query(`UPDATE users SET role = 'teacher', expertise = $2, bio = coalesce(bio, $3), token_version = token_version + 1 WHERE id = $1`, [u.id, a.expertise, a.bio]);
        await audit(db, ctx, { action: 'user.role_change', targetType: 'user', targetId: u.id, oldValues: { role: 'student' }, newValues: { role: 'teacher', via: 'application' } });
      }
      await notify(db, u.id, { type: 'application', title: status === 'approved' ? 'You are now a Teacher' : 'Instructor application declined', body: d.reason || '', link: '/teach' });
      ctx.after(() => emails.applicationDecision(u, status === 'approved', d.reason));
      return { ok: true };
    }),
  },

  // ------------------------------------------------------------- users (AD-03, AD-04, AD-05, AD-06)
  users: {
    auth: ADMIN,
    schema: z.object({ q: str(100).default(''), role: z.enum(['', 'student', 'teacher', 'admin']).default(''), status: z.enum(['', 'active', 'inactive']).default(''), page }),
    run: async ({ data }) => {
      const params = [likeEscape(data.q), data.role, data.status, PAGE, (data.page - 1) * PAGE];
      const where = `($1 = '' OR name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%') AND ($2 = '' OR role::text = $2)
                     AND ($3 = '' OR ($3 = 'active') = is_active)`;
      const [list, total] = await Promise.all([
        query(`SELECT * FROM users WHERE ${where} ORDER BY created_at DESC LIMIT $4 OFFSET $5`, params),
        query(`SELECT count(*)::int AS n FROM users WHERE ${where}`, params.slice(0, 3)),
      ]);
      return {
        users: list.rows.map((u) => ({ ...publicUser(u), isActive: u.is_active, deactivatedAt: u.deactivated_at, deactivatedReason: u.deactivated_reason })),
        total: total.rows[0].n, pageSize: PAGE,
      };
    },
  },

  changeRole: {
    auth: ADMIN,
    schema: z.object({ userId: id, role: z.enum(['student', 'teacher', 'admin']) }),
    run: async (ctx) => {
      const { rows: [t] } = await query(`SELECT * FROM users WHERE id = $1`, [ctx.data.userId]);
      if (!t) notFound('User');
      const role = ctx.data.role;
      if (t.role === role) return { ok: true, unchanged: true };
      if (t.is_root) await blocked(ctx, 'user.role_change_blocked', t, 'The first Admin cannot be demoted (AD-04)', { role });
      if (t.role === 'admin' && t.id !== ctx.user.id) await blocked(ctx, 'user.role_change_blocked', t, 'An Admin cannot remove the Admin rights of another Admin (AD-04)', { role });
      if (!t.is_active) fail(409, 'Reactivate this account before changing its role');
      return tx(async (db) => {
        // token_version bump: the user signs in again, with 2FA if the new role needs it (AD-07).
        await db.query(`UPDATE users SET role = $2, token_version = token_version + 1 WHERE id = $1`, [t.id, role]);
        await audit(db, ctx, { action: 'user.role_change', targetType: 'user', targetId: t.id, oldValues: { role: t.role }, newValues: { role, email: t.email } });
        await notify(db, t.id, { type: 'account', title: 'Your role changed', body: `Your account is now ${role}. Please sign in again.` });
        return { ok: true };
      });
    },
  },

  setActive: {
    auth: ADMIN,
    schema: z.object({ userId: id, active: z.boolean(), reason: str(500).default('') }),
    run: async (ctx) => {
      const { rows: [t] } = await query(`SELECT * FROM users WHERE id = $1`, [ctx.data.userId]);
      if (!t) notFound('User');
      const { active, reason } = ctx.data;
      if (!active) {
        if (t.is_root) await blocked(ctx, 'user.deactivate_blocked', t, 'The first Admin cannot be deactivated (AD-04)', { active });
        if (t.role === 'admin') await blocked(ctx, 'user.deactivate_blocked', t, 'Admins cannot be suspended or deactivated (AD-04)', { active });
        if (reason.length < 3) fail(400, 'Give a reason for deactivating this account');
      }
      if (t.is_active === active) return { ok: true, unchanged: true };
      return tx(async (db) => {
        await db.query(
          `UPDATE users SET is_active = $2, deactivated_at = CASE WHEN $2 THEN NULL ELSE now() END,
                  deactivated_reason = CASE WHEN $2 THEN NULL ELSE $3 END, token_version = token_version + 1 WHERE id = $1`,
          [t.id, active, reason]);
        await audit(db, ctx, { action: active ? 'user.reactivate' : 'user.deactivate', targetType: 'user', targetId: t.id,
          oldValues: { isActive: t.is_active }, newValues: { isActive: active, reason: reason || null, email: t.email } });
        return { ok: true };
      });
    },
  },

  // ------------------------------------------------------------- certificates (CC-03)
  certificates: {
    auth: ADMIN,
    schema: z.object({ q: str(100).default(''), page }),
    run: async ({ data }) => {
      const params = [likeEscape(data.q), PAGE, (data.page - 1) * PAGE];
      const where = `($1 = '' OR c.code ILIKE '%'||$1||'%' OR c.recipient_name ILIKE '%'||$1||'%' OR c.course_title ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%')`;
      const [list, total] = await Promise.all([
        query(`SELECT c.*, u.email FROM certificates c JOIN users u ON u.id = c.user_id WHERE ${where} ORDER BY c.issued_at DESC LIMIT $2 OFFSET $3`, params),
        query(`SELECT count(*)::int AS n FROM certificates c JOIN users u ON u.id = c.user_id WHERE ${where}`, params.slice(0, 1)),
      ]);
      return { certificates: list.rows, total: total.rows[0].n, pageSize: PAGE };
    },
  },

  revokeCertificate: {
    auth: ADMIN,
    schema: z.object({ id, reason: reqStr(1000, 5) }),
    run: async (ctx) => tx(async (db) => {
      const { rows: [c] } = await db.query(`SELECT * FROM certificates WHERE id = $1 FOR UPDATE`, [ctx.data.id]);
      if (!c) notFound('Certificate');
      if (c.revoked_at) fail(409, 'Already revoked');
      await db.query(`UPDATE certificates SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1`, [c.id, ctx.user.id, ctx.data.reason]);
      await audit(db, ctx, { action: 'certificate.revoke', targetType: 'certificate', targetId: c.id, oldValues: { revoked: false }, newValues: { code: c.code, reason: ctx.data.reason } });
      await notify(db, c.user_id, { type: 'certificate', title: 'Certificate revoked', body: `${c.course_title}: ${ctx.data.reason}` });
      return { ok: true };
    }),
  },

  // ------------------------------------------------------------- audit log
  audit: {
    auth: ADMIN,
    schema: auditSchema,
    run: async ({ data }) => {
      const f = auditFilters(data);
      const n = f.params.length;
      const [list, total, actions] = await Promise.all([
        query(`SELECT a.* FROM audit_logs a ${f.where} ORDER BY a.created_at DESC, a.id DESC LIMIT $${n + 1} OFFSET $${n + 2}`, [...f.params, 50, (data.page - 1) * 50]),
        query(`SELECT count(*)::int AS n FROM audit_logs a ${f.where}`, f.params),
        query(`SELECT DISTINCT action FROM audit_logs ORDER BY action`),
      ]);
      return { entries: list.rows, total: total.rows[0].n, pageSize: 50, actions: actions.rows.map((r) => r.action) };
    },
  },

  auditCsv: {
    auth: ADMIN,
    schema: auditSchema,
    run: async (ctx) => {
      const f = auditFilters(ctx.data);
      const { rows } = await pool.query(`SELECT a.* FROM audit_logs a ${f.where} ORDER BY a.created_at DESC, a.id DESC LIMIT 50000`, f.params);
      const cols = ['id', 'created_at', 'actor_email', 'actor_role', 'actor_id', 'action', 'target_type', 'target_id', 'old_values', 'new_values', 'ip', 'user_agent'];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(c === 'created_at' ? new Date(r[c]).toISOString() : r[c])).join(','))].join('\r\n');
      await audit(null, ctx, { action: 'audit.export', targetType: 'audit_log', newValues: { filters: ctx.data, rows: rows.length } });
      return { csv, filename: `audit-log-${new Date().toISOString().slice(0, 10)}.csv` };
    },
  },
});
