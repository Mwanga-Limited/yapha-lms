import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  agent, auditCount, buy, call, correctAnswers, loginRoot, makeTeacher, pool, registerStudent, resetDb, watchVideo, wrongAnswers,
} from './helpers.js';

let root, teacher;
before(async () => {
  await resetDb();
  root = await loginRoot();
  teacher = (await makeTeacher('Unlock Teacher', root)).a;
});
after(async () => { await pool.end(); });

const quiz = (id) => ({ id, kind: 'quiz', title: 'Check-in', questions: [
  { id: 'a', type: 'single', prompt: '2 + 2 = ?', options: [{ id: 'x', text: '4' }, { id: 'y', text: '5' }], correct: ['x'] },
  { id: 'b', type: 'truefalse', prompt: 'The sky is blue', correct: ['true'] },
  { id: 'c', type: 'multi', prompt: 'Even numbers', options: [{ id: 'm', text: '2' }, { id: 'n', text: '3' }, { id: 'o', text: '4' }], correct: ['m', 'o'] },
] });
/** Three sections: a reading + a quiz, then a video, then a reading and a free preview lesson. */
const threeSections = (unlock) => ({
  sections: [
    { id: 's1', title: 'Basics', items: [{ id: 't1', kind: 'lesson', title: 'Read me', type: 'text', body: 'Hi' }, quiz('q1')] },
    { id: 's2', title: 'Watch', items: [{ id: 'v2', kind: 'lesson', title: 'Video', type: 'video', videoUrl: 'https://example.com/v.mp4' }] },
    { id: 's3', title: 'Finish', items: [
      { id: 't3', kind: 'lesson', title: 'Last reading', type: 'text', body: 'Bye' },
      { id: 'p3', kind: 'lesson', title: 'Taster', type: 'text', body: 'Free', preview: true },
    ] },
  ],
  completion: { lessons: ['t1', 'v2', 't3'], quizzes: ['q1'] },
  ...(unlock ? { unlock } : {}),
});

async function course(title, unlock) {
  const { body: { id } } = await call(teacher, 'courses', 'create', { title }).expect(200);
  await call(teacher, 'courses', 'updateMeta', { id, title, summary: 's', category: 'Maths', outline: 'o', suggestedPrice: 5000 }).expect(200);
  await call(teacher, 'courses', 'saveContent', { id, content: threeSections(unlock) }).expect(200);
  await call(teacher, 'courses', 'submit', { id }).expect(200);
  const q = (await call(root, 'admin', 'reviewQueue')).body.queue.find((x) => x.course.id === id);
  await call(root, 'admin', 'approveCourse', { versionId: q.versionId }).expect(200);
  await call(teacher, 'courses', 'publish', { id }).expect(200);
  return id;
}
const player = async (s, id) => (await call(s.a, 'learn', 'player', { courseId: id }).expect(200)).body;
const lockOf = (p) => p.outline.map((s) => s.locked?.reason ?? 'open');
/** Move this learner's enrolment back in time, as if they enrolled `hours` ago. */
const enrolledHoursAgo = (s, id, hours) => pool.query(
  `UPDATE enrollments SET enrolled_at = now() - make_interval(hours => $3) WHERE user_id = $1 AND course_id = $2`, [s.id, id, hours]);

describe('Completion-based unlocking (every course)', () => {
  test('only Section 1 is open; each section opens when the one before it is complete', async () => {
    const id = await course('In Order');
    const s = await registerStudent('Orderly');
    await buy(s, id);
    let p = await player(s, id);
    assert.deepEqual(lockOf(p), ['open', 'completion', 'completion']);
    assert.equal(p.outline[1].locked.after, 'Basics');
    assert.equal(p.outline[1].items[0].locked, true);
    assert.equal(p.outline[2].items.find((i) => i.id === 'p3').locked, false, 'free preview lessons stay open');

    // Locked lessons and quizzes are refused by the server, not just hidden.
    const r = await call(s.a, 'learn', 'lesson', { courseId: id, lessonId: 'v2' }).expect(423);
    assert.equal(r.body.code, 'SECTION_LOCKED');
    assert.match(r.body.error ?? r.body.message, /Complete "Basics"/);
    await call(s.a, 'learn', 'savePosition', { courseId: id, lessonId: 'v2', positionSec: 5, durationSec: 60 }).expect(423);
    await call(s.a, 'learn', 'completeLesson', { courseId: id, lessonId: 't3' }).expect(423);
    await call(s.a, 'learn', 'lesson', { courseId: id, lessonId: 'p3' }).expect(200);

    // Half of Section 1 is not enough: the quiz must be passed too.
    await call(s.a, 'learn', 'completeLesson', { courseId: id, lessonId: 't1' }).expect(200);
    await call(s.a, 'learn', 'submitQuiz', { courseId: id, quizId: 'q1', answers: wrongAnswers }).expect(200);
    assert.deepEqual(lockOf(await player(s, id)), ['open', 'completion', 'completion']);
    await call(s.a, 'learn', 'submitQuiz', { courseId: id, quizId: 'q1', answers: correctAnswers }).expect(200);
    p = await player(s, id);
    assert.deepEqual(lockOf(p), ['open', 'open', 'completion']);
    assert.equal(p.outline[2].locked.after, 'Watch');

    // Section 2's video completes only when watched (its own completion rule), and that opens Section 3.
    await call(s.a, 'learn', 'completeLesson', { courseId: id, lessonId: 'v2' }).expect(409);
    await watchVideo(s, id, 'v2');
    assert.deepEqual(lockOf(await player(s, id)), ['open', 'open', 'open']);
    const done = await call(s.a, 'learn', 'completeLesson', { courseId: id, lessonId: 't3' }).expect(200);
    assert.ok(done.body.certificate?.code, 'the course can be completed as usual');
  });

  test('the player resumes only at a lesson the learner can open', async () => {
    const id = await course('Resume Open');
    const s = await registerStudent('Resumer');
    await buy(s, id);
    await call(s.a, 'learn', 'lesson', { courseId: id, lessonId: 'p3' }).expect(200);   // last opened: a preview in Section 3
    assert.equal((await player(s, id)).resumeItemId, 'p3');
    await pool.query(`UPDATE enrollments SET last_item_id = 'v2' WHERE user_id = $1`, [s.id]);
    assert.equal((await player(s, id)).resumeItemId, null);
  });

  test('learners keep the progress they already had', async () => {
    const id = await course('Kept Progress');
    const s = await registerStudent('Keeper');
    await buy(s, id);
    // Progress recorded before unlocking existed (e.g. Section 3 finished first) is kept and counts.
    const { rows: [e] } = await pool.query(`SELECT id, tenant_id FROM enrollments WHERE user_id = $1 AND course_id = $2`, [s.id, id]);
    await pool.query(`INSERT INTO lesson_progress (tenant_id, enrollment_id, lesson_id, completed_at) VALUES ($1, $2, 't3', now())`, [e.tenant_id, e.id]);
    const p = await player(s, id);
    assert.equal(p.outline[2].items.find((i) => i.id === 't3').done, true);
    assert.equal(p.progress.done, 1);
  });
});

describe('Time-based unlocking (optional)', () => {
  test('with a delay, the whole course opens that long after enrolment, then sections unlock in order', async () => {
    const id = await course('Two Day Wait', { afterHours: 48 });
    const s = await registerStudent('Patient');
    await buy(s, id);
    let p = await player(s, id);
    assert.deepEqual(lockOf(p), ['time', 'time', 'time']);
    assert.equal(p.unlock.afterHours, 48);
    const opens = new Date(p.outline[0].locked.opensAt).getTime();
    assert.ok(Math.abs(opens - (Date.now() + 48 * 3600e3)) < 60_000, 'opens 48 hours after enrolling');
    const r = await call(s.a, 'learn', 'lesson', { courseId: id, lessonId: 't1' }).expect(423);
    assert.equal(r.body.code, 'COURSE_LOCKED');
    await call(s.a, 'learn', 'quiz', { courseId: id, quizId: 'q1' }).expect(423);
    await call(s.a, 'learn', 'submitQuiz', { courseId: id, quizId: 'q1', answers: correctAnswers }).expect(423);
    await call(s.a, 'learn', 'lesson', { courseId: id, lessonId: 'p3' }).expect(200);   // preview stays open

    await enrolledHoursAgo(s, id, 47);
    assert.deepEqual(lockOf(await player(s, id)), ['time', 'time', 'time']);
    await enrolledHoursAgo(s, id, 48);
    p = await player(s, id);
    assert.deepEqual(lockOf(p), ['open', 'completion', 'completion']);
    await call(s.a, 'learn', 'lesson', { courseId: id, lessonId: 't1' }).expect(200);
  });

  test("the delay is part of the course: invalid values are refused; a course without one opens at once", async () => {
    const { body: { id } } = await call(teacher, 'courses', 'create', { title: 'Bad Delay' }).expect(200);
    await call(teacher, 'courses', 'saveContent', { id, content: threeSections({ afterHours: 0 }) }).expect(400);
    await call(teacher, 'courses', 'saveContent', { id, content: threeSections({ afterHours: 1.5 }) }).expect(400);
    await call(teacher, 'courses', 'saveContent', { id, content: threeSections({ afterHours: 9000 }) }).expect(400);
    const ok = await call(teacher, 'courses', 'saveContent', { id, content: threeSections({ afterHours: 7 * 24 }) }).expect(200);
    assert.deepEqual(ok.body.content.unlock, { afterHours: 168 });
    const none = await call(teacher, 'courses', 'saveContent', { id, content: threeSections() }).expect(200);
    assert.deepEqual(none.body.content.unlock, { afterHours: null }, 'no delay unless one is set');
  });

  test("a teacher's change to the delay only takes effect when an Admin approves it", async () => {
    const id = await course('Teacher Proposes');
    const s = await registerStudent('Early Learner');
    await buy(s, id);
    await call(teacher, 'courses', 'startRevision', { id }).expect(200);
    await call(teacher, 'courses', 'saveContent', { id, content: threeSections({ afterHours: 24 }) }).expect(200);
    await call(teacher, 'courses', 'submit', { id }).expect(200);
    assert.deepEqual(lockOf(await player(s, id)), ['open', 'completion', 'completion'], 'not in effect while waiting for review');
    assert.equal((await call(agent(), 'courses', 'detail', { id })).body.unlock.afterHours, null);
    const q = (await call(root, 'admin', 'reviewQueue')).body.queue.find((x) => x.course.id === id);
    await call(root, 'admin', 'approveCourse', { versionId: q.versionId }).expect(200);
    assert.deepEqual(lockOf(await player(s, id)), ['time', 'time', 'time'], 'in effect once approved');
    assert.equal((await call(agent(), 'courses', 'detail', { id })).body.unlock.afterHours, 24);
  });

  test('an Admin sets the delay directly; it applies at once, survives a later approval, and is audited', async () => {
    const id = await course('Admin Sets It');
    const s = await registerStudent('Admin Learner');
    await buy(s, id);
    await call(teacher, 'courses', 'setUnlock', { id, unlock: { afterHours: 12 } }).expect(403);
    await call(root, 'courses', 'setUnlock', { id, unlock: { afterHours: 0 } }).expect(400);

    // A revision the teacher is working on picks up the Admin's setting too, so approving it later doesn't undo it.
    await call(teacher, 'courses', 'startRevision', { id }).expect(200);
    const r = await call(root, 'courses', 'setUnlock', { id, unlock: { afterHours: 72 } }).expect(200);
    assert.deepEqual(r.body.unlock, { afterHours: 72 });
    assert.deepEqual(lockOf(await player(s, id)), ['time', 'time', 'time']);
    const g = (await call(teacher, 'courses', 'get', { id })).body;
    assert.equal(g.draft.content.unlock.afterHours, 72);
    await call(teacher, 'courses', 'submit', { id }).expect(200);
    const q = (await call(root, 'admin', 'reviewQueue')).body.queue.find((x) => x.course.id === id);
    await call(root, 'admin', 'approveCourse', { versionId: q.versionId }).expect(200);
    assert.equal((await call(agent(), 'courses', 'detail', { id })).body.unlock.afterHours, 72);

    assert.equal(await auditCount('course.unlock_set', id), 1);
    const { rows: [a] } = await pool.query(`SELECT old_values, new_values, actor_role FROM audit_logs WHERE action = 'course.unlock_set' AND target_id = $1`, [id]);
    assert.deepEqual(a.old_values, { afterHours: null });
    assert.deepEqual(a.new_values, { afterHours: 72 });

    // Removing the delay opens the course again (Section 1 first, as always).
    await call(root, 'courses', 'setUnlock', { id, unlock: { afterHours: null } }).expect(200);
    assert.deepEqual(lockOf(await player(s, id)), ['open', 'completion', 'completion']);
  });
});
