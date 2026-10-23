import { z } from 'zod';
import { query, tx } from '../db.js';
import { actionEndpoint, id } from '../lib/actions.js';
import { audit } from '../lib/audit.js';
import {
  LOCK_HOURS, MAX_ATTEMPTS, PASS_MARK, computeProgress, findItem, gradeQuiz, learnerQuiz, outlineOf,
} from '../lib/content.js';
import { fail, notFound } from '../lib/errors.js';
import { activeEnrollment, checkCompletion, learnerState, loadCourseWithLive } from '../lib/learning.js';
import { emails } from '../lib/mailer.js';
import { notify } from '../lib/notify.js';
import { courseMeta, lessonPayload } from './courses.js';

const itemRef = z.string().trim().min(1).max(64);

/** EN-02: only an enrolled learner can open lessons or quizzes. */
async function requireEnrollment(db, ctx, courseId, lock = false) {
  const course = await loadCourseWithLive(db, courseId);
  if (!course || !course.live_content) notFound('Course');
  const enrollment = await activeEnrollment(db, ctx.user.id, courseId, lock);
  if (!enrollment) fail(403, 'Enrol in this course to open its lessons and quizzes', { code: 'NOT_ENROLLED' });
  return { course, enrollment };
}

function quizStateView(s) {
  const now = new Date();
  let used = s?.attempts_used ?? 0;
  let lockedUntil = s?.locked_until ? new Date(s.locked_until) : null;
  if (lockedUntil && lockedUntil <= now) { used = 0; lockedUntil = null; }  // QZ-02: lock over → 3 more attempts
  const passed = !!s?.passed_at;
  return {
    attemptsUsed: used, attemptsLeft: passed ? 0 : MAX_ATTEMPTS - used, maxAttempts: MAX_ATTEMPTS, passMark: PASS_MARK,
    lockedUntil: lockedUntil ? lockedUntil.toISOString() : null, passed, bestScore: s?.best_score ?? null,
  };
}

async function touch(db, enrollmentId, itemId) {
  await db.query(`UPDATE enrollments SET last_item_id = $2, last_accessed_at = now() WHERE id = $1`, [enrollmentId, itemId]);
}

export const learnRoutes = actionEndpoint({
  /** EN-01 (one active enrolment) + EN-03 (verified email). Payment is Phase 2. */
  enrol: {
    auth: 'user',
    verified: true,
    schema: z.object({ courseId: id }),
    run: async (ctx) => tx(async (db) => {
      const { rows: [c] } = await db.query(`SELECT * FROM courses WHERE id = $1`, [ctx.data.courseId]);
      if (!c) notFound('Course');
      if (c.status !== 'published') fail(409, 'This course is not open for enrolment');
      if (c.teacher_id === ctx.user.id) fail(409, 'You teach this course');
      const { rows } = await db.query(
        `INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2)
         ON CONFLICT (user_id, course_id) WHERE status = 'active' DO NOTHING RETURNING *`, [ctx.user.id, c.id]);
      if (!rows[0]) return { ok: true, alreadyEnrolled: true };
      await audit(db, ctx, { action: 'enrollment.create', targetType: 'enrollment', targetId: rows[0].id, newValues: { courseId: c.id, course: c.title } });
      await notify(db, ctx.user.id, { type: 'enrollment', title: 'Enrolment confirmed', body: `You're enrolled in ${c.title}.`, link: `/learn/${c.id}` });
      const learner = ctx.user;
      ctx.after(() => emails.enrolled(learner, c));
      return { ok: true, enrollmentId: rows[0].id };
    }),
  },

  /** Course player shell: outline with per-item progress, resume point, certificate. */
  player: {
    auth: 'user',
    schema: z.object({ courseId: id }),
    run: async (ctx) => {
      const db = { query };
      const { course, enrollment } = await requireEnrollment(db, ctx, ctx.data.courseId);
      const st = await learnerState(db, enrollment.id);
      const outline = outlineOf(course.live_content).map((s) => ({
        ...s,
        items: s.items.map((it) => ({
          ...it,
          done: it.kind === 'lesson' ? st.completed.has(it.id) : st.passed.has(it.id),
          ...(it.kind === 'quiz' ? { state: quizStateView(st.quizStates[it.id]) } : {}),
        })),
      }));
      const { rows: [cert] } = await query(`SELECT code, issued_at, revoked_at, revoke_reason FROM certificates WHERE enrollment_id = $1`, [enrollment.id]);
      return {
        course: { ...courseMeta(course), teacherName: course.teacher_name },
        outline,
        progress: computeProgress(course.live_content, st.completed, st.passed),
        resumeItemId: enrollment.last_item_id && findItem(course.live_content, enrollment.last_item_id) ? enrollment.last_item_id : null,
        completedAt: enrollment.completed_at,
        certificate: cert ? { code: cert.code, issuedAt: cert.issued_at, revoked: !!cert.revoked_at, revokeReason: cert.revoke_reason } : null,
      };
    },
  },

  lesson: {
    auth: 'user',
    schema: z.object({ courseId: id, lessonId: itemRef }),
    run: async (ctx) => {
      const db = { query };
      const { course, enrollment } = await requireEnrollment(db, ctx, ctx.data.courseId);
      const lesson = findItem(course.live_content, ctx.data.lessonId, 'lesson');
      if (!lesson) notFound('Lesson');
      await touch(db, enrollment.id, lesson.id);
      const { rows: [p] } = await query(`SELECT completed_at, position_sec FROM lesson_progress WHERE enrollment_id = $1 AND lesson_id = $2`, [enrollment.id, lesson.id]);
      return { lesson: lessonPayload(lesson), completed: !!p?.completed_at, positionSec: p?.position_sec ?? 0 };
    },
  },

  savePosition: {
    auth: 'user',
    schema: z.object({ courseId: id, lessonId: itemRef, positionSec: z.number().min(0).max(1e7) }),
    run: async (ctx) => {
      const db = { query };
      const { course, enrollment } = await requireEnrollment(db, ctx, ctx.data.courseId);
      if (!findItem(course.live_content, ctx.data.lessonId, 'lesson')) notFound('Lesson');
      await query(
        `INSERT INTO lesson_progress (enrollment_id, lesson_id, position_sec) VALUES ($1,$2,$3)
         ON CONFLICT (enrollment_id, lesson_id) DO UPDATE SET position_sec = EXCLUDED.position_sec, updated_at = now()`,
        [enrollment.id, ctx.data.lessonId, ctx.data.positionSec]);
      return { ok: true };
    },
  },

  completeLesson: {
    auth: 'user',
    schema: z.object({ courseId: id, lessonId: itemRef }),
    run: async (ctx) => tx(async (db) => {
      const { course, enrollment } = await requireEnrollment(db, ctx, ctx.data.courseId, true);
      const lesson = findItem(course.live_content, ctx.data.lessonId, 'lesson');
      if (!lesson) notFound('Lesson');
      await db.query(
        `INSERT INTO lesson_progress (enrollment_id, lesson_id, completed_at) VALUES ($1,$2, now())
         ON CONFLICT (enrollment_id, lesson_id) DO UPDATE SET completed_at = coalesce(lesson_progress.completed_at, now()), updated_at = now()`,
        [enrollment.id, lesson.id]);
      await touch(db, enrollment.id, lesson.id);
      const certificate = await checkCompletion(db, ctx, enrollment, course);
      const st = await learnerState(db, enrollment.id);
      return { progress: computeProgress(course.live_content, st.completed, st.passed), certificate: certificate ? { code: certificate.code } : null };
    }),
  },

  quiz: {
    auth: 'user',
    schema: z.object({ courseId: id, quizId: itemRef }),
    run: async (ctx) => {
      const db = { query };
      const { course, enrollment } = await requireEnrollment(db, ctx, ctx.data.courseId);
      const quiz = findItem(course.live_content, ctx.data.quizId, 'quiz');
      if (!quiz) notFound('Quiz');
      await touch(db, enrollment.id, quiz.id);
      const [{ rows: [s] }, { rows: attempts }] = await Promise.all([
        query(`SELECT * FROM quiz_states WHERE enrollment_id = $1 AND quiz_id = $2`, [enrollment.id, quiz.id]),
        query(`SELECT score, passed, created_at FROM quiz_attempts WHERE enrollment_id = $1 AND quiz_id = $2 ORDER BY created_at DESC LIMIT 20`, [enrollment.id, quiz.id]),
      ]);
      return { quiz: learnerQuiz(quiz), state: quizStateView(s), attempts };
    },
  },

  /** QZ-01/QZ-02: 70% pass mark, 3 attempts, then a 24h lock followed by 3 more attempts. */
  submitQuiz: {
    auth: 'user',
    schema: z.object({ courseId: id, quizId: itemRef, answers: z.record(z.string(), z.array(z.string().max(64)).max(10)) }),
    run: async (ctx) => tx(async (db) => {
      const { course, enrollment } = await requireEnrollment(db, ctx, ctx.data.courseId, true);
      const quiz = findItem(course.live_content, ctx.data.quizId, 'quiz');
      if (!quiz) notFound('Quiz');
      await db.query(`INSERT INTO quiz_states (enrollment_id, quiz_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [enrollment.id, quiz.id]);
      const { rows: [s] } = await db.query(`SELECT * FROM quiz_states WHERE enrollment_id = $1 AND quiz_id = $2 FOR UPDATE`, [enrollment.id, quiz.id]);
      if (s.passed_at) fail(409, 'You have already passed this quiz');
      const now = new Date();
      let used = s.attempts_used;
      if (s.locked_until && new Date(s.locked_until) > now) {
        fail(423, `This quiz is locked until ${new Date(s.locked_until).toISOString()}`, { lockedUntil: s.locked_until, code: 'QUIZ_LOCKED' });
      }
      if (s.locked_until || used >= MAX_ATTEMPTS) used = 0;  // the 24h lock has passed: a new set of 3 attempts

      const g = gradeQuiz(quiz, ctx.data.answers);
      used += 1;
      const lockedUntil = !g.passed && used >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCK_HOURS * 3600 * 1000) : null;
      const { rows: [ns] } = await db.query(
        `UPDATE quiz_states SET attempts_used = $3, locked_until = $4, passed_at = CASE WHEN $5 THEN now() ELSE passed_at END,
                best_score = greatest(coalesce(best_score, 0), $6), updated_at = now()
          WHERE enrollment_id = $1 AND quiz_id = $2 RETURNING *`,
        [enrollment.id, quiz.id, used, lockedUntil, g.passed, g.score]);
      await db.query(`INSERT INTO quiz_attempts (enrollment_id, quiz_id, score, passed, answers) VALUES ($1,$2,$3,$4,$5)`,
        [enrollment.id, quiz.id, g.score, g.passed, ctx.data.answers]);
      await audit(db, ctx, { action: 'quiz.attempt', targetType: 'enrollment', targetId: enrollment.id,
        newValues: { quizId: quiz.id, score: g.score, passed: g.passed, attempt: used, lockedUntil } });

      const state = quizStateView(ns);
      await notify(db, ctx.user.id, { type: 'quiz', title: g.passed ? `Quiz passed: ${quiz.title}` : `Quiz result: ${quiz.title}`,
        body: `You scored ${g.score}%.${!g.passed && state.lockedUntil ? ' The quiz is locked for 24 hours.' : ''}`, link: `/learn/${course.id}` });
      const learner = ctx.user;
      ctx.after(() => emails.quizResult(learner, course, quiz, g.score, g.passed, state));

      const certificate = g.passed ? await checkCompletion(db, ctx, enrollment, course) : null;
      const st = await learnerState(db, enrollment.id);
      return {
        result: { score: g.score, passed: g.passed, correct: g.correct, total: g.total, questions: g.results },
        state, progress: computeProgress(course.live_content, st.completed, st.passed),
        certificate: certificate ? { code: certificate.code } : null,
      };
    }),
  },
});
