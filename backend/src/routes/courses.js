import { z } from 'zod';
import { query, tx } from '../db.js';
import { actionEndpoint, id, page, reqStr, str } from '../lib/actions.js';
import { audit } from '../lib/audit.js';
import {
  MAX_ATTEMPTS, computeProgress, emptyContent, findItem, lessonsOf, normaliseContent, outlineOf, quizzesOf, submissionProblems,
} from '../lib/content.js';
import { fail, notFound } from '../lib/errors.js';
import { notify, notifyAdmins } from '../lib/notify.js';
import { signedFileUrl } from '../lib/security.js';
import { learnerState } from '../lib/learning.js';

const PAGE_SIZE = 12;
const fileUrl = (fid) => (fid ? `/api/files/${fid}` : null);
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function lessonPayload(lesson) {
  return {
    id: lesson.id, title: lesson.title, type: lesson.type, body: lesson.body, videoUrl: lesson.videoUrl || null,
    fileUrl: lesson.fileId ? signedFileUrl(lesson.fileId) : null, fileName: lesson.fileName || null, durationMin: lesson.durationMin,
  };
}

export function courseMeta(c) {
  return {
    id: c.id, title: c.title, summary: c.summary, description: c.description, outline: c.outline, category: c.category,
    level: c.level, language: c.language, thumbnailFileId: c.thumbnail_file_id, thumbnailUrl: fileUrl(c.thumbnail_file_id),
    status: c.status, publishedAt: c.published_at, createdAt: c.created_at, updatedAt: c.updated_at, teacherId: c.teacher_id,
  };
}

/** Load a course the current user may manage (owner, or Admin when allowAdmin). */
async function manageable(db, ctx, courseId, { allowAdmin = false, lock = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM courses WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [courseId]);
  const c = rows[0];
  if (!c) notFound('Course');
  const isOwner = c.teacher_id === ctx.user.id;
  if (!isOwner && !(allowAdmin && ctx.user.role === 'admin')) fail(403, 'You can only manage your own courses');
  return c;
}

async function draftVersion(db, course, lock = false) {
  if (!course.draft_version_id) return null;
  const { rows } = await db.query(`SELECT * FROM course_versions WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [course.draft_version_id]);
  return rows[0] ?? null;
}

async function setStatus(db, ctx, course, status, action, extra = '') {
  const { rows } = await db.query(`UPDATE courses SET status = $2, updated_at = now() ${extra} WHERE id = $1 RETURNING *`, [course.id, status]);
  await audit(db, ctx, { action, targetType: 'course', targetId: course.id, oldValues: { status: course.status }, newValues: { status } });
  return rows[0];
}

/** Lesson files must belong to the course's teacher; file names come from the server. */
async function checkContentFiles(db, teacherId, content) {
  const ids = [...new Set(lessonsOf(content).map((l) => l.fileId).filter(Boolean))];
  if (!ids.length) return;
  const { rows } = await db.query(`SELECT id, original_name, purpose FROM files WHERE id = ANY($1) AND owner_id = $2`, [ids, teacherId]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const s of content.sections) for (const it of s.items) {
    if (it.kind !== 'lesson' || !it.fileId) continue;
    const f = byId.get(it.fileId);
    if (!f || !['lesson_file', 'lesson_video'].includes(f.purpose)) fail(400, `Lesson "${it.title}" refers to a file you did not upload`);
    it.fileName = f.original_name;
  }
}

const metaSchema = z.object({
  id,
  title: reqStr(200),
  summary: str(500).default(''),
  description: str(10_000).default(''),
  outline: str(10_000).default(''),
  category: str(80).default(''),
  level: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  language: str(60).default('English'),
  thumbnailFileId: id.nullable().optional(),
});
const META_COLS = ['title', 'summary', 'description', 'outline', 'category', 'level', 'language', 'thumbnail_file_id'];

export const courseRoutes = actionEndpoint({
  // ------------------------------------------------------------- public catalogue
  catalog: {
    auth: 'public',
    schema: z.object({ q: str(100).default(''), category: str(80).default(''), level: z.enum(['', 'beginner', 'intermediate', 'advanced']).default(''), page }),
    run: async ({ data }) => {
      const q = likeEscape(data.q);
      const params = [q, data.category, data.level, PAGE_SIZE, (data.page - 1) * PAGE_SIZE];
      const where = `c.status = 'published'
        AND ($1 = '' OR c.title ILIKE '%'||$1||'%' OR c.summary ILIKE '%'||$1||'%' OR c.category ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%')
        AND ($2 = '' OR c.category = $2) AND ($3 = '' OR c.level = $3)`;
      const [list, total, cats] = await Promise.all([
        query(`SELECT c.*, u.name AS teacher_name, v.content,
                      (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id AND e.status = 'active') AS learners
                 FROM courses c JOIN users u ON u.id = c.teacher_id JOIN course_versions v ON v.id = c.live_version_id
                WHERE ${where} ORDER BY c.published_at DESC NULLS LAST LIMIT $4 OFFSET $5`, params),
        query(`SELECT count(*)::int AS n FROM courses c JOIN users u ON u.id = c.teacher_id WHERE ${where}`, params.slice(0, 3)),
        query(`SELECT DISTINCT category FROM courses WHERE status = 'published' AND category <> '' ORDER BY category`),
      ]);
      return {
        courses: list.rows.map((c) => ({
          ...courseMeta(c), teacherName: c.teacher_name, learners: c.learners,
          lessonCount: lessonsOf(c.content).length, quizCount: quizzesOf(c.content).length,
        })),
        total: total.rows[0].n, pageSize: PAGE_SIZE, categories: cats.rows.map((r) => r.category),
      };
    },
  },

  detail: {
    auth: 'public',
    schema: z.object({ id }),
    run: async ({ data, user }) => {
      const { rows } = await query(
        `SELECT c.*, v.content AS live_content, u.name AS t_name, u.bio AS t_bio, u.expertise AS t_expertise, u.photo_file_id AS t_photo,
                (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id AND e.status = 'active') AS learners,
                (SELECT count(*) FROM courses c2 WHERE c2.teacher_id = c.teacher_id AND c2.status = 'published') AS t_courses
           FROM courses c JOIN users u ON u.id = c.teacher_id LEFT JOIN course_versions v ON v.id = c.live_version_id
          WHERE c.id = $1`, [data.id]);
      const c = rows[0];
      if (!c) notFound('Course');
      const enrollment = user ? (await query(`SELECT id, completed_at FROM enrollments WHERE user_id = $1 AND course_id = $2 AND status = 'active'`, [user.id, c.id])).rows[0] : null;
      const canManage = user && (user.id === c.teacher_id || user.role === 'admin');
      // Unpublished/archived courses are hidden from the catalog but existing learners keep access (CR-05).
      if (c.status !== 'published' && !enrollment && !canManage) notFound('Course');
      return {
        course: { ...courseMeta(c), learners: c.learners },
        outline: c.live_content ? outlineOf(c.live_content) : [],
        teacher: { id: c.teacher_id, name: c.t_name, bio: c.t_bio, expertise: c.t_expertise, photoUrl: fileUrl(c.t_photo), courses: c.t_courses },
        viewer: { enrolled: !!enrollment, completed: !!enrollment?.completed_at, canManage: !!canManage, signedIn: !!user, emailVerified: !!user?.email_verified_at },
      };
    },
  },

  /** Free preview lessons can be opened by anyone. */
  preview: {
    auth: 'public',
    schema: z.object({ courseId: id, lessonId: z.string().max(64) }),
    run: async ({ data }) => {
      const { rows } = await query(`SELECT c.status, v.content FROM courses c JOIN course_versions v ON v.id = c.live_version_id WHERE c.id = $1`, [data.courseId]);
      const lesson = rows[0] && rows[0].status === 'published' ? findItem(rows[0].content, data.lessonId, 'lesson') : null;
      if (!lesson || !lesson.preview) fail(403, 'Enrol in this course to open this lesson');
      return { lesson: lessonPayload(lesson) };
    },
  },

  // ------------------------------------------------------------- teacher: authoring
  mine: {
    auth: ['teacher', 'admin'],
    run: async (ctx) => {
      const { rows } = await query(
        `SELECT c.*, d.status AS draft_status, d.version_no AS draft_no,
                (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id AND e.status = 'active') AS learners,
                (SELECT reason FROM course_reviews r WHERE r.course_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_reason,
                (SELECT decision FROM course_reviews r WHERE r.course_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_decision
           FROM courses c LEFT JOIN course_versions d ON d.id = c.draft_version_id
          WHERE c.teacher_id = $1 ORDER BY c.updated_at DESC`, [ctx.user.id]);
      return {
        courses: rows.map((c) => ({
          ...courseMeta(c), learners: c.learners, revision: c.draft_status ? { status: c.draft_status, versionNo: c.draft_no } : null,
          hasLive: !!c.live_version_id, lastDecision: c.last_decision, lastReason: c.last_reason,
        })),
      };
    },
  },

  create: {
    auth: ['teacher', 'admin'],
    schema: z.object({ title: reqStr(200) }),
    run: async (ctx) => tx(async (db) => {
      const { rows: [c] } = await db.query(`INSERT INTO courses (teacher_id, title) VALUES ($1,$2) RETURNING *`, [ctx.user.id, ctx.data.title]);
      const { rows: [v] } = await db.query(`INSERT INTO course_versions (course_id, version_no, content) VALUES ($1, 1, $2) RETURNING id`, [c.id, emptyContent()]);
      await db.query(`UPDATE courses SET draft_version_id = $2 WHERE id = $1`, [c.id, v.id]);
      await audit(db, ctx, { action: 'course.create', targetType: 'course', targetId: c.id, newValues: { title: c.title } });
      return { id: c.id };
    }),
  },

  /** Full authoring view (owner or Admin): metadata, live + draft content, review history. */
  get: {
    auth: ['teacher', 'admin'],
    schema: z.object({ id }),
    run: async (ctx) => {
      const c = await manageable({ query }, ctx, ctx.data.id, { allowAdmin: true });
      const [live, draft, reviews, teacher, learners] = await Promise.all([
        c.live_version_id ? query(`SELECT * FROM course_versions WHERE id = $1`, [c.live_version_id]) : { rows: [] },
        draftVersion({ query }, c).then((v) => ({ rows: v ? [v] : [] })),
        query(`SELECT r.*, u.name AS admin_name FROM course_reviews r JOIN users u ON u.id = r.admin_id WHERE r.course_id = $1 ORDER BY r.created_at DESC`, [c.id]),
        query(`SELECT id, name, email FROM users WHERE id = $1`, [c.teacher_id]),
        query(`SELECT count(*)::int AS n FROM enrollments WHERE course_id = $1`, [c.id]),
      ]);
      const d = draft.rows[0];
      // Signed links so the teacher and reviewing Admin can open uploaded lesson files.
      const fileIds = [...new Set([live.rows[0]?.content, d?.content].filter(Boolean).flatMap((x) => lessonsOf(x).map((l) => l.fileId)).filter(Boolean))];
      return {
        fileUrls: Object.fromEntries(fileIds.map((f) => [f, signedFileUrl(f)])),
        course: courseMeta(c),
        teacher: teacher.rows[0],
        enrollments: learners.rows[0].n,
        live: live.rows[0] ? { id: live.rows[0].id, versionNo: live.rows[0].version_no, content: live.rows[0].content, reviewedAt: live.rows[0].reviewed_at } : null,
        draft: d ? { id: d.id, versionNo: d.version_no, status: d.status, content: d.content, submittedAt: d.submitted_at, updatedAt: d.updated_at } : null,
        problems: d ? submissionProblems(c, d.content) : [],
        reviews: reviews.rows.map((r) => ({ id: r.id, versionNo: r.version_no, decision: r.decision, reason: r.reason, adminName: r.admin_name, createdAt: r.created_at })),
      };
    },
  },

  /** Minor edits (title, description, outline…) go live immediately (spec 1.2). */
  updateMeta: {
    auth: ['teacher', 'admin'],
    schema: metaSchema,
    run: async (ctx) => tx(async (db) => {
      const c = await manageable(db, ctx, ctx.data.id, { lock: true });
      if (c.status === 'archived') fail(409, 'Archived courses cannot be edited');
      if (c.status === 'in_review') fail(409, 'This course is being reviewed. You can edit it again after the decision.');
      const d = ctx.data;
      if (d.thumbnailFileId) {
        const f = await db.query(`SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND purpose = 'thumbnail'`, [d.thumbnailFileId, ctx.user.id]);
        if (!f.rowCount) fail(400, 'Upload the thumbnail first');
      }
      const values = [d.title, d.summary, d.description, d.outline, d.category, d.level, d.language,
        d.thumbnailFileId === undefined ? c.thumbnail_file_id : d.thumbnailFileId];
      const { rows: [u] } = await db.query(
        `UPDATE courses SET title=$2, summary=$3, description=$4, outline=$5, category=$6, level=$7, language=$8, thumbnail_file_id=$9, updated_at=now()
          WHERE id = $1 RETURNING *`, [c.id, ...values]);
      const oldV = {}, newV = {};
      for (const k of META_COLS) if (String(c[k] ?? '') !== String(u[k] ?? '')) { oldV[k] = c[k]; newV[k] = u[k]; }
      if (Object.keys(newV).length) await audit(db, ctx, { action: c.live_version_id ? 'course.minor_edit_live' : 'course.update', targetType: 'course', targetId: c.id, oldValues: oldV, newValues: newV });
      return { course: courseMeta(u) };
    }),
  },

  /** Lessons, quizzes and the completion rule are saved to the draft version only (CR-04). */
  saveContent: {
    auth: ['teacher', 'admin'],
    schema: z.object({ id, content: z.unknown() }),
    run: async (ctx) => tx(async (db) => {
      const c = await manageable(db, ctx, ctx.data.id, { lock: true });
      const v = await draftVersion(db, c, true);
      if (!v) fail(409, c.live_version_id ? 'Start a new revision before changing lessons, quizzes or the completion rule' : 'No draft to edit');
      if (!['draft', 'rejected'].includes(v.status)) fail(409, 'This version is under review and cannot be changed');
      let content;
      try { content = normaliseContent(ctx.data.content); } catch (e) { fail(400, e.issues?.[0] ? `${e.issues[0].path.join('.')}: ${e.issues[0].message}` : e.message); }
      await checkContentFiles(db, c.teacher_id, content);
      await db.query(`UPDATE course_versions SET content = $2, updated_at = now() WHERE id = $1`, [v.id, content]);
      await db.query(`UPDATE courses SET updated_at = now() WHERE id = $1`, [c.id]);
      const sum = (x) => ({ sections: x.sections.length, lessons: lessonsOf(x).length, quizzes: quizzesOf(x).length, required: x.completion.lessons.length + x.completion.quizzes.length });
      await audit(db, ctx, { action: 'course.content_saved', targetType: 'course', targetId: c.id, oldValues: sum(v.content), newValues: { ...sum(content), versionNo: v.version_no } });
      return { content, problems: submissionProblems(c, content) };
    }),
  },

  startRevision: {
    auth: ['teacher', 'admin'],
    schema: z.object({ id }),
    run: async (ctx) => tx(async (db) => {
      const c = await manageable(db, ctx, ctx.data.id, { lock: true });
      if (!c.live_version_id) fail(409, 'This course has no approved version yet');
      if (c.draft_version_id) fail(409, 'A revision already exists');
      if (c.status === 'archived') fail(409, 'Archived courses cannot be edited');
      const { rows: [live] } = await db.query(`SELECT content FROM course_versions WHERE id = $1`, [c.live_version_id]);
      const { rows: [{ n }] } = await db.query(`SELECT coalesce(max(version_no), 0) + 1 AS n FROM course_versions WHERE course_id = $1`, [c.id]);
      const { rows: [v] } = await db.query(`INSERT INTO course_versions (course_id, version_no, content) VALUES ($1,$2,$3) RETURNING id`, [c.id, n, live.content]);
      await db.query(`UPDATE courses SET draft_version_id = $2, updated_at = now() WHERE id = $1`, [c.id, v.id]);
      await audit(db, ctx, { action: 'course.revision_start', targetType: 'course', targetId: c.id, newValues: { versionNo: n } });
      return { ok: true };
    }),
  },

  discardRevision: {
    auth: ['teacher', 'admin'],
    schema: z.object({ id }),
    run: async (ctx) => tx(async (db) => {
      const c = await manageable(db, ctx, ctx.data.id, { lock: true });
      const v = await draftVersion(db, c, true);
      if (!v || !c.live_version_id) fail(409, 'There is no revision to discard');
      if (v.status === 'in_review') fail(409, 'This revision is being reviewed');
      await db.query(`UPDATE courses SET draft_version_id = NULL, updated_at = now() WHERE id = $1`, [c.id]);
      await db.query(`DELETE FROM course_versions WHERE id = $1`, [v.id]);
      await audit(db, ctx, { action: 'course.revision_discard', targetType: 'course', targetId: c.id, oldValues: { versionNo: v.version_no } });
      return { ok: true };
    }),
  },

  /** CR-01 checks + EN-03 (verified email) before review. */
  submit: {
    auth: ['teacher', 'admin'],
    verified: true,
    schema: z.object({ id }),
    run: async (ctx) => tx(async (db) => {
      const c = await manageable(db, ctx, ctx.data.id, { lock: true });
      if (c.status === 'archived') fail(409, 'Archived courses cannot be submitted');
      const v = await draftVersion(db, c, true);
      if (!v || !['draft', 'rejected'].includes(v.status)) fail(409, 'Nothing to submit');
      const problems = submissionProblems(c, v.content);
      if (problems.length) fail(422, 'The course is not ready to submit', { problems });
      await db.query(`UPDATE course_versions SET status = 'in_review', submitted_at = now(), updated_at = now() WHERE id = $1`, [v.id]);
      if (!c.live_version_id) await db.query(`UPDATE courses SET status = 'in_review', updated_at = now() WHERE id = $1`, [c.id]);
      await audit(db, ctx, { action: v.status === 'rejected' ? 'course.resubmit' : 'course.submit', targetType: 'course', targetId: c.id,
        oldValues: { status: c.status, versionStatus: v.status }, newValues: { versionNo: v.version_no, revision: !!c.live_version_id } });
      await notifyAdmins(db, { type: 'review', title: c.live_version_id ? 'Course revision to review' : 'Course to review', body: c.title, link: '/admin/reviews' });
      return { ok: true };
    }),
  },

  /** CR-02: only an approved course can be published. */
  publish: {
    auth: ['teacher', 'admin'],
    schema: z.object({ id }),
    run: async (ctx) => tx(async (db) => {
      const c = await manageable(db, ctx, ctx.data.id, { allowAdmin: true, lock: true });
      if (!c.live_version_id || !['approved', 'unpublished'].includes(c.status)) fail(409, 'Only an approved course can be published');
      await setStatus(db, ctx, c, 'published', 'course.publish', ', published_at = coalesce(published_at, now())');
      return { ok: true };
    }),
  },

  unpublish: {
    auth: ['teacher', 'admin'],
    schema: z.object({ id }),
    run: async (ctx) => tx(async (db) => {
      const c = await manageable(db, ctx, ctx.data.id, { allowAdmin: true, lock: true });
      if (c.status !== 'published') fail(409, 'Only a published course can be unpublished');
      await setStatus(db, ctx, c, 'unpublished', 'course.unpublish');
      return { ok: true };
    }),
  },

  archive: {
    auth: ['teacher', 'admin'],
    schema: z.object({ id }),
    run: async (ctx) => tx(async (db) => {
      const c = await manageable(db, ctx, ctx.data.id, { allowAdmin: true, lock: true });
      if (c.status === 'archived') fail(409, 'Already archived');
      const v = await draftVersion(db, c);
      if (v?.status === 'in_review') fail(409, 'Wait for the review decision before archiving');
      await setStatus(db, ctx, c, 'archived', 'course.archive', ', archived_at = now()');
      return { ok: true };
    }),
  },

  /** CR-05: a course with enrolments (or any review history) can only be archived. */
  remove: {
    auth: ['teacher', 'admin'],
    schema: z.object({ id }),
    run: async (ctx) => tx(async (db) => {
      const c = await manageable(db, ctx, ctx.data.id, { allowAdmin: true, lock: true });
      const { rows: [n] } = await db.query(
        `SELECT (SELECT count(*) FROM enrollments WHERE course_id = $1)::int AS e, (SELECT count(*) FROM course_reviews WHERE course_id = $1)::int AS r`, [c.id]);
      if (n.e > 0) fail(409, 'This course has enrolments, so it cannot be deleted. Archive it instead.');
      if (n.r > 0 || c.status !== 'draft') fail(409, 'This course has review history, so it cannot be deleted. Archive it instead.');
      await db.query(`UPDATE courses SET live_version_id = NULL, draft_version_id = NULL WHERE id = $1`, [c.id]);
      await db.query(`DELETE FROM courses WHERE id = $1`, [c.id]);
      await audit(db, ctx, { action: 'course.delete', targetType: 'course', targetId: c.id, oldValues: { title: c.title } });
      return { ok: true };
    }),
  },

  // ------------------------------------------------------------- teacher/admin: learners & quiz attempts
  learners: {
    auth: ['teacher', 'admin'],
    schema: z.object({ id }),
    run: async (ctx) => {
      const c = await manageable({ query }, ctx, ctx.data.id, { allowAdmin: true });
      const content = c.live_version_id ? (await query(`SELECT content FROM course_versions WHERE id = $1`, [c.live_version_id])).rows[0].content : emptyContent();
      const { rows } = await query(
        `SELECT e.*, u.name, u.email FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = $1 ORDER BY e.enrolled_at DESC`, [c.id]);
      const quizzes = quizzesOf(content);
      const learners = [];
      for (const e of rows) {
        const st = await learnerState({ query }, e.id);
        learners.push({
          enrollmentId: e.id, userId: e.user_id, name: e.name, email: e.email, status: e.status, enrolledAt: e.enrolled_at, completedAt: e.completed_at,
          progress: computeProgress(content, st.completed, st.passed).percent,
          quizzes: quizzes.map((q) => {
            const s = st.quizStates[q.id];
            const locked = s?.locked_until && new Date(s.locked_until) > new Date();
            return { quizId: q.id, title: q.title, attemptsUsed: s?.attempts_used ?? 0, maxAttempts: MAX_ATTEMPTS, passed: !!s?.passed_at, bestScore: s?.best_score ?? null, lockedUntil: locked ? s.locked_until : null };
          }),
        });
      }
      return { learners };
    },
  },

  /** QZ-02: a Teacher (of this course) or Admin can reset attempts. */
  resetAttempts: {
    auth: ['teacher', 'admin'],
    schema: z.object({ enrollmentId: id, quizId: z.string().max(64) }),
    run: async (ctx) => tx(async (db) => {
      const { rows: [e] } = await db.query(`SELECT * FROM enrollments WHERE id = $1`, [ctx.data.enrollmentId]);
      if (!e) notFound('Enrolment');
      const c = await manageable(db, ctx, e.course_id, { allowAdmin: true });
      const { rows: [old] } = await db.query(`SELECT * FROM quiz_states WHERE enrollment_id = $1 AND quiz_id = $2 FOR UPDATE`, [e.id, ctx.data.quizId]);
      if (!old) fail(404, 'This learner has not attempted that quiz');
      await db.query(`UPDATE quiz_states SET attempts_used = 0, locked_until = NULL, updated_at = now() WHERE enrollment_id = $1 AND quiz_id = $2`, [e.id, ctx.data.quizId]);
      await audit(db, ctx, { action: 'quiz.reset_attempts', targetType: 'enrollment', targetId: e.id,
        oldValues: { quizId: ctx.data.quizId, attemptsUsed: old.attempts_used, lockedUntil: old.locked_until }, newValues: { attemptsUsed: 0, lockedUntil: null } });
      await notify(db, e.user_id, { type: 'quiz', title: 'Quiz attempts reset', body: `You have ${MAX_ATTEMPTS} new attempts in ${c.title}.`, link: `/learn/${c.id}` });
      return { ok: true };
    }),
  },
});

