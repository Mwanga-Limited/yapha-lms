import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  ROOT, agent, auditCount, call, codeFromMail, correctAnswers, loginPrivileged, loginRoot, makeTeacher, outbox, pool,
  publishedCourse, registerStudent, resetDb, sampleContent, submittedCourse, tokenFromMail, wrongAnswers,
  api,
} from './helpers.js';

let root;
before(async () => { await resetDb(); root = await loginRoot(); });
after(async () => { await pool.end(); });

describe('Authentication & security', () => {
  test('register, verify email, sign in, sign out', async () => {
    const a = agent();
    await call(a, 'auth', 'register', { name: 'Ada Learner', email: 'ada@test.dev', password: 'Password123!' }).expect(200);
    let me = await call(a, 'auth', 'me');
    assert.equal(me.body.user.role, 'student');            // AD-02
    assert.equal(me.body.user.emailVerified, false);
    await call(a, 'auth', 'verifyEmail', { token: tokenFromMail('ada@test.dev', 'verify-email') }).expect(200);
    me = await call(a, 'auth', 'me');
    assert.equal(me.body.user.emailVerified, true);
    await call(a, 'auth', 'logout').expect(200);
    assert.equal((await call(a, 'auth', 'me')).body.user, null);
    const b = agent();
    const r = await call(b, 'auth', 'login', { email: 'ADA@test.dev', password: 'Password123!' }).expect(200);
    assert.equal(r.body.user.email, 'ada@test.dev');        // students sign in without a second factor
  });

  test('duplicate email, weak password and wrong password are refused; failures are logged', async () => {
    await call(agent(), 'auth', 'register', { name: 'X', email: 'ada@test.dev', password: 'Password123!' }).expect(409);
    await call(agent(), 'auth', 'register', { name: 'X', email: 'weak@test.dev', password: 'short' }).expect(400);
    // Every rule is enforced by the server too, and the error says what is missing.
    const noSpecial = await call(agent(), 'auth', 'register', { name: 'X', email: 'weak2@test.dev', password: 'Password123' }).expect(400);
    assert.match(noSpecial.body.error, /special character/);
    const noUpper = await call(agent(), 'auth', 'register', { name: 'X', email: 'weak3@test.dev', password: 'password123!' }).expect(400);
    assert.match(noUpper.body.error, /uppercase/);
    await call(agent(), 'auth', 'login', { email: 'ada@test.dev', password: 'nope' }).expect(401);
    assert.ok((await auditCount('auth.login_failed', 'ada@test.dev')) >= 1);
  });

  test('login rate limiting locks an account after 5 failures', async () => {
    await registerStudent('Locked Out', { verify: false });
    for (let i = 0; i < 5; i++) await call(agent(), 'auth', 'login', { email: 'lockedout@test.dev', password: 'bad' }).expect(401);
    await call(agent(), 'auth', 'login', { email: 'lockedout@test.dev', password: 'Password123!' }).expect(429);
  });

  test('password reset link works once and signs out other sessions', async () => {
    const s = await registerStudent('Reset Me');
    await call(agent(), 'auth', 'requestPasswordReset', { email: s.email }).expect(200);
    const token = tokenFromMail(s.email, 'reset-password');
    await call(agent(), 'auth', 'resetPassword', { token, password: 'NewPassword456!' }).expect(200);
    await call(agent(), 'auth', 'resetPassword', { token, password: 'NewPassword789!' }).expect(400);
    assert.equal((await call(s.a, 'auth', 'me')).body.user, null);
    await call(agent(), 'auth', 'login', { email: s.email, password: 'NewPassword456!' }).expect(200);
  });

  test('AD-07: Admins need a second factor; wrong codes are refused', async () => {
    const a = agent();
    const r = await call(a, 'auth', 'login', ROOT).expect(200);
    assert.ok(r.body.mfa && !r.body.user);
    assert.equal((await call(a, 'auth', 'me')).body.user, null);   // no session yet
    await call(a, 'auth', 'verifyMfa', { token: r.body.mfa.token, code: '000000' }).expect(401);
    await call(a, 'auth', 'verifyMfa', { token: r.body.mfa.token, code: codeFromMail(ROOT.email) }).expect(200);
    assert.equal((await call(a, 'auth', 'me')).body.user.role, 'admin');
  });

  test('role checks protect admin and teacher actions', async () => {
    const s = await registerStudent('Nosy Student');
    await call(s.a, 'admin', 'users').expect(403);
    await call(s.a, 'courses', 'create', { title: 'Hack' }).expect(403);
    await call(agent(), 'account', 'dashboard').expect(401);
  });
});

describe('Admin rules (AD-03 … AD-08)', () => {
  test('AD-08 / AD-03: becoming a Teacher needs an application approved by an Admin', async () => {
    const t = await registerStudent('Would Teach');
    await call(t.a, 'courses', 'create', { title: 'Too early' }).expect(403);
    await call(t.a, 'account', 'applyTeacher', { bio: 'short' , expertise: 'x' }).expect(400);
    await call(t.a, 'account', 'applyTeacher', { bio: 'I have ten years of experience teaching.', expertise: 'Physics' }).expect(200);
    await call(t.a, 'account', 'applyTeacher', { bio: 'I have ten years of experience teaching.', expertise: 'Physics' }).expect(409);
    const { body } = await call(root, 'admin', 'applications');
    const app = body.applications.find((x) => x.email === t.email);
    await call(root, 'admin', 'decideApplication', { id: app.id, decision: 'decline' }).expect(400); // reason required
    await call(root, 'admin', 'decideApplication', { id: app.id, decision: 'approve' }).expect(200);
    assert.equal((await call(t.a, 'auth', 'me')).body.user, null, 'role change signs the user out so 2FA applies');
    const ta = await loginPrivileged(t.email, 'Password123!');
    assert.equal((await call(ta, 'auth', 'me')).body.user.role, 'teacher');
  });

  test('teacher sign-up option creates an application, not a teacher', async () => {
    const a = agent();
    await call(a, 'auth', 'register', { name: 'Signup Teacher', email: 'st@test.dev', password: 'Password123!', joinAs: 'teacher',
      application: { bio: 'Professional chemist and lecturer for years.', expertise: 'Chemistry' } }).expect(200);
    assert.equal((await call(a, 'auth', 'me')).body.user.role, 'student');
    const apps = (await call(a, 'account', 'myApplications')).body.applications;
    assert.equal(apps[0].status, 'pending');
  });

  test('AD-04: Admins cannot demote or deactivate other Admins; the first Admin is protected; attempts are logged (AD-06)', async () => {
    const s = await registerStudent('Second Admin');
    await call(root, 'admin', 'changeRole', { userId: s.id, role: 'admin' }).expect(200);
    const second = await loginPrivileged(s.email, 'Password123!');
    const rootId = (await pool.query(`SELECT id FROM users WHERE is_root`)).rows[0].id;

    const before = await auditCount('user.role_change_blocked');
    await call(second, 'admin', 'changeRole', { userId: rootId, role: 'student' }).expect(403);
    await call(root, 'admin', 'changeRole', { userId: s.id, role: 'teacher' }).expect(403);
    await call(root, 'admin', 'changeRole', { userId: rootId, role: 'teacher' }).expect(403);
    assert.equal(await auditCount('user.role_change_blocked'), before + 3);

    await call(root, 'admin', 'setActive', { userId: s.id, active: false, reason: 'test' }).expect(403);
    await call(second, 'admin', 'setActive', { userId: rootId, active: false, reason: 'test' }).expect(403);
    assert.ok((await auditCount('user.deactivate_blocked')) >= 2);
    assert.ok((await auditCount('user.role_change', s.id)) >= 1);

    // The database refuses too, even if the application were bypassed.
    await assert.rejects(pool.query(`UPDATE users SET role = 'student' WHERE is_root`), /AD-04/);
    await assert.rejects(pool.query(`DELETE FROM users WHERE id = $1`, [s.id]), /AD-05/);
  });

  test('AD-05: deactivation keeps the account, signs it out and blocks sign-in; reactivation restores it', async () => {
    const s = await registerStudent('Pause Me');
    await call(root, 'admin', 'setActive', { userId: s.id, active: false }).expect(400);   // reason required
    await call(root, 'admin', 'setActive', { userId: s.id, active: false, reason: 'Spam' }).expect(200);
    assert.equal((await call(s.a, 'auth', 'me')).body.user, null);
    await call(agent(), 'auth', 'login', { email: s.email, password: 'Password123!' }).expect(403);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [s.id])).rows[0].n, 1);
    await call(root, 'admin', 'setActive', { userId: s.id, active: true }).expect(200);
    await call(agent(), 'auth', 'login', { email: s.email, password: 'Password123!' }).expect(200);
  });
});

describe('Course approval (CR-01 … CR-05)', () => {
  let teacher;
  before(async () => { teacher = (await makeTeacher('Tess Teacher', root)).a; });

  test('CR-01: incomplete courses cannot be submitted', async () => {
    const { body: { id } } = await call(teacher, 'courses', 'create', { title: 'Empty' }).expect(200);
    const r = await call(teacher, 'courses', 'submit', { id }).expect(422);
    assert.ok(r.body.problems.some((p) => /outline/.test(p)));
    assert.ok(r.body.problems.some((p) => /lesson/.test(p)));
    assert.ok(r.body.problems.some((p) => /quiz/.test(p)));
    const noRule = { ...sampleContent(), completion: { lessons: [], quizzes: [] } };
    await call(teacher, 'courses', 'updateMeta', { id, title: 'Empty', summary: 's', category: 'c', outline: 'o' }).expect(200);
    await call(teacher, 'courses', 'saveContent', { id, content: noRule }).expect(200);
    const r2 = await call(teacher, 'courses', 'submit', { id }).expect(422);
    assert.ok(r2.body.problems.some((p) => /completion rule/.test(p)));
  });

  test('CR-02/CR-03: only Admins approve, rejection needs a reason, resubmission keeps every reason', async () => {
    const id = await submittedCourse(teacher, 'Reviewed Course');
    const queue = (await call(root, 'admin', 'reviewQueue')).body.queue;
    const v = queue.find((x) => x.course.id === id);
    await call(teacher, 'admin', 'approveCourse', { versionId: v.versionId }).expect(403);
    await call(teacher, 'courses', 'publish', { id }).expect(409);                          // not approved yet
    await call(root, 'admin', 'rejectCourse', { versionId: v.versionId, reason: '' }).expect(400);
    await call(root, 'admin', 'rejectCourse', { versionId: v.versionId, reason: 'Add more examples' }).expect(200);
    let g = (await call(teacher, 'courses', 'get', { id })).body;
    assert.equal(g.course.status, 'rejected');
    assert.equal(g.reviews[0].reason, 'Add more examples');

    await call(teacher, 'courses', 'submit', { id }).expect(200);
    await call(root, 'admin', 'rejectCourse', { versionId: v.versionId, reason: 'Still needs a summary' }).expect(200);
    await call(teacher, 'courses', 'submit', { id }).expect(200);
    await call(root, 'admin', 'approveCourse', { versionId: v.versionId }).expect(200);
    g = (await call(teacher, 'courses', 'get', { id })).body;
    assert.equal(g.course.status, 'approved');
    assert.deepEqual(g.reviews.map((r) => r.decision), ['approved', 'rejected', 'rejected']);
    await call(teacher, 'courses', 'publish', { id }).expect(200);
    const cat = (await call(agent(), 'courses', 'catalog', { q: 'Reviewed' })).body;
    assert.equal(cat.courses.length, 1);
  });

  test('CR-04: content changes on a published course need re-approval; the live version stays visible', async () => {
    const id = await publishedCourse(teacher, root, 'Living Course');
    const changed = sampleContent();
    changed.sections[0].items[0].title = 'Welcome (new)';
    await call(teacher, 'courses', 'saveContent', { id, content: changed }).expect(409);          // must start a revision
    await call(teacher, 'courses', 'updateMeta', { id, title: 'Living Course', summary: 'Typo fixed', category: 'Mathematics', outline: 'o' }).expect(200);
    await call(teacher, 'courses', 'startRevision', { id }).expect(200);
    await call(teacher, 'courses', 'saveContent', { id, content: changed }).expect(200);
    await call(teacher, 'courses', 'submit', { id }).expect(200);
    let d = (await call(agent(), 'courses', 'detail', { id })).body;
    assert.equal(d.course.summary, 'Typo fixed');                                                   // minor edit is live
    assert.equal(d.outline[0].items[0].title, 'Welcome');                                           // old content still live
    assert.equal(d.course.status, 'published');
    const v = (await call(root, 'admin', 'reviewQueue')).body.queue.find((x) => x.course.id === id);
    assert.equal(v.isRevision, true);
    await call(root, 'admin', 'approveCourse', { versionId: v.versionId }).expect(200);
    d = (await call(agent(), 'courses', 'detail', { id })).body;
    assert.equal(d.outline[0].items[0].title, 'Welcome (new)');
  });

  test('CR-05: unpublished courses stay open to learners; enrolled courses cannot be deleted', async () => {
    const id = await publishedCourse(teacher, root, 'Soon Hidden');
    const s = await registerStudent('Early Bird');
    await call(s.a, 'learn', 'enrol', { courseId: id }).expect(200);
    await call(teacher, 'courses', 'unpublish', { id }).expect(200);
    assert.equal((await call(agent(), 'courses', 'catalog', { q: 'Soon Hidden' })).body.courses.length, 0);
    await call(agent(), 'courses', 'detail', { id }).expect(404);
    await call(s.a, 'learn', 'player', { courseId: id }).expect(200);
    await call(s.a, 'learn', 'lesson', { courseId: id, lessonId: 'l2' }).expect(200);
    await call(teacher, 'courses', 'remove', { id }).expect(409);
    await call(teacher, 'courses', 'archive', { id }).expect(200);
    await call(s.a, 'learn', 'player', { courseId: id }).expect(200);
    await assert.rejects(pool.query(`DELETE FROM courses WHERE id = $1`, [id]), /foreign key/);
  });

  test('a Teacher cannot manage another Teacher\'s course', async () => {
    const other = (await makeTeacher('Other Teacher', root)).a;
    const id = await submittedCourse(teacher, 'Mine Only');
    await call(other, 'courses', 'get', { id }).expect(403);
    await call(other, 'courses', 'updateMeta', { id, title: 'Stolen' }).expect(403);
  });
});

describe('Enrolment access (EN-01 … EN-03)', () => {
  let teacher, courseId;
  before(async () => {
    teacher = (await makeTeacher('Enrol Teacher', root)).a;
    courseId = await publishedCourse(teacher, root, 'Enrolment Course');
  });

  test('EN-03: email must be verified before enrolling or submitting a course', async () => {
    const s = await registerStudent('Unverified', { verify: false });
    const r = await call(s.a, 'learn', 'enrol', { courseId }).expect(403);
    assert.equal(r.body.code, 'EMAIL_NOT_VERIFIED');
  });

  test('EN-01: at most one active enrolment per course', async () => {
    const s = await registerStudent('Double Enrol');
    await call(s.a, 'learn', 'enrol', { courseId }).expect(200);
    const again = await call(s.a, 'learn', 'enrol', { courseId }).expect(200);
    assert.equal(again.body.alreadyEnrolled, true);
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM enrollments WHERE user_id = $1 AND course_id = $2`, [s.id, courseId]);
    assert.equal(n, 1);
    await assert.rejects(pool.query(`INSERT INTO enrollments (tenant_id, user_id, course_id) SELECT tenant_id, $1, $2 FROM users WHERE id = $1`, [s.id, courseId]), /duplicate key/);
  });

  test('EN-02: only enrolled learners open lessons and quizzes; preview lessons are public', async () => {
    const s = await registerStudent('Not Enrolled');
    await call(s.a, 'learn', 'lesson', { courseId, lessonId: 'l2' }).expect(403);
    await call(s.a, 'learn', 'quiz', { courseId, quizId: 'q1' }).expect(403);
    await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: correctAnswers }).expect(403);
    await call(agent(), 'courses', 'preview', { courseId, lessonId: 'l1' }).expect(200);
    await call(agent(), 'courses', 'preview', { courseId, lessonId: 'l2' }).expect(403);
    await call(s.a, 'learn', 'enrol', { courseId }).expect(200);
    const q = await call(s.a, 'learn', 'quiz', { courseId, quizId: 'q1' }).expect(200);
    assert.ok(q.body.quiz.questions.every((x) => !('correct' in x)), 'answers are never sent to learners');
  });

  test('progress, resume position and dashboard', async () => {
    const s = await registerStudent('Progress Pat');
    await call(s.a, 'learn', 'enrol', { courseId }).expect(200);
    await call(s.a, 'learn', 'savePosition', { courseId, lessonId: 'l2', positionSec: 42.5 }).expect(200);
    const l = await call(s.a, 'learn', 'lesson', { courseId, lessonId: 'l2' }).expect(200);
    assert.equal(l.body.positionSec, 42.5);
    const c = await call(s.a, 'learn', 'completeLesson', { courseId, lessonId: 'l1' }).expect(200);
    assert.equal(c.body.progress.percent, 33);
    const dash = (await call(s.a, 'account', 'dashboard')).body.courses[0];
    assert.equal(dash.progress.percent, 33);
    assert.equal(dash.resume.id, 'l1');
  });
});

describe('Quiz attempts (QZ-01, QZ-02)', () => {
  let teacher, courseId;
  before(async () => {
    teacher = (await makeTeacher('Quiz Teacher', root)).a;
    courseId = await publishedCourse(teacher, root, 'Quiz Course');
  });

  test('grading: 70% pass mark, multi-select must match exactly', async () => {
    const s = await registerStudent('Grader');
    await call(s.a, 'learn', 'enrol', { courseId }).expect(200);
    const r = await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: { a: ['x'], b: ['true'], c: ['m'] } }).expect(200);
    assert.equal(r.body.result.score, 66.67);
    assert.equal(r.body.result.passed, false);
    assert.equal(r.body.state.attemptsLeft, 2);
    const p = await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: correctAnswers }).expect(200);
    assert.equal(p.body.result.score, 100);
    assert.equal(p.body.result.passed, true);
    await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: correctAnswers }).expect(409);
  });

  test('3 failures lock the quiz for 24h, then 3 more attempts; Teacher/Admin can reset', async () => {
    const s = await registerStudent('Struggler');
    await call(s.a, 'learn', 'enrol', { courseId }).expect(200);
    for (let i = 0; i < 3; i++) await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: wrongAnswers }).expect(200);
    const locked = await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: correctAnswers }).expect(423);
    const hours = (new Date(locked.body.lockedUntil) - Date.now()) / 3600e3;
    assert.ok(hours > 23.9 && hours <= 24);

    // Simulate the 24 hours passing: 3 more attempts.
    const { rows: [e] } = await pool.query(`SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2`, [s.id, courseId]);
    await pool.query(`UPDATE quiz_states SET locked_until = now() - interval '1 minute' WHERE enrollment_id = $1`, [e.id]);
    const st = (await call(s.a, 'learn', 'quiz', { courseId, quizId: 'q1' })).body.state;
    assert.equal(st.attemptsLeft, 3);
    for (let i = 0; i < 3; i++) await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: wrongAnswers }).expect(200);
    await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: correctAnswers }).expect(423);

    // Reset by the course Teacher (students cannot).
    await call(s.a, 'courses', 'resetAttempts', { enrollmentId: e.id, quizId: 'q1' }).expect(403);
    await call(teacher, 'courses', 'resetAttempts', { enrollmentId: e.id, quizId: 'q1' }).expect(200);
    assert.equal((await call(s.a, 'learn', 'quiz', { courseId, quizId: 'q1' })).body.state.attemptsLeft, 3);
    for (let i = 0; i < 3; i++) await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: wrongAnswers }).expect(200);
    await call(root, 'courses', 'resetAttempts', { enrollmentId: e.id, quizId: 'q1' }).expect(200);  // and by an Admin
    await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: correctAnswers }).expect(200);
    assert.ok((await auditCount('quiz.reset_attempts', e.id)) === 2);
  });
});

describe('Certificates (CC-01 … CC-03)', () => {
  let teacher, courseId;
  before(async () => {
    teacher = (await makeTeacher('Cert Teacher', root)).a;
    courseId = await publishedCourse(teacher, root, 'Certificate Course');
  });

  test('CC-01/CC-02: complete only when every required lesson and quiz is done; exactly one certificate', async () => {
    const s = await registerStudent('Finisher');
    await call(s.a, 'learn', 'enrol', { courseId }).expect(200);
    let r = await call(s.a, 'learn', 'completeLesson', { courseId, lessonId: 'l1' }).expect(200);
    assert.equal(r.body.certificate, null);
    r = await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: correctAnswers }).expect(200);
    assert.equal(r.body.certificate, null, 'l2 is still required');
    r = await call(s.a, 'learn', 'completeLesson', { courseId, lessonId: 'l2' }).expect(200);
    const code = r.body.certificate.code;
    assert.match(code, /^EL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await call(s.a, 'learn', 'completeLesson', { courseId, lessonId: 'l2' }).expect(200);
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM certificates WHERE user_id = $1`, [s.id]);
    assert.equal(n, 1);

    const v = await agent().get(`${api('certificates')}/${code}`).expect(200);
    assert.equal(v.body.certificate.valid, true);
    assert.equal(v.body.certificate.recipientName, 'Finisher');
    const pdf = await agent().get(`${api('certificates')}/${code}?format=pdf`).buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); }).expect(200);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
    assert.ok(outbox.some((m) => m.to === s.email && /Certificate issued/.test(m.subject)));
  });

  test('CC-03: an Admin can revoke with a reason; verification then shows it as revoked', async () => {
    const s = await registerStudent('Revoked Rita');
    await call(s.a, 'learn', 'enrol', { courseId }).expect(200);
    await call(s.a, 'learn', 'completeLesson', { courseId, lessonId: 'l1' });
    await call(s.a, 'learn', 'completeLesson', { courseId, lessonId: 'l2' });
    const r = await call(s.a, 'learn', 'submitQuiz', { courseId, quizId: 'q1', answers: correctAnswers });
    const code = r.body.certificate.code;
    const certs = (await call(root, 'admin', 'certificates', { q: code })).body.certificates;
    await call(root, 'admin', 'revokeCertificate', { id: certs[0].id, reason: '' }).expect(400);
    await call(teacher, 'admin', 'revokeCertificate', { id: certs[0].id, reason: 'Cheating' }).expect(403);
    await call(root, 'admin', 'revokeCertificate', { id: certs[0].id, reason: 'Academic misconduct' }).expect(200);
    const v = await agent().get(`${api('certificates')}/${code}`).expect(200);
    assert.equal(v.body.certificate.valid, false);
    assert.equal(v.body.certificate.revokeReason, 'Academic misconduct');
    await agent().get(`${api('certificates')}/${code}?format=pdf`).expect(410);
    assert.ok((await auditCount('certificate.revoke', certs[0].id)) === 1);
  });
});

describe('Certificates are for Students only', () => {
  let teacher, courseId;
  before(async () => {
    teacher = (await makeTeacher('Owner Teacher', root)).a;
    courseId = await publishedCourse(teacher, root, 'Students Only Course');
  });

  test('Teachers and Admins cannot enrol, open the player or the learner dashboard', async () => {
    const other = (await makeTeacher('Curious Teacher', root)).a;
    const r = await call(other, 'learn', 'enrol', { courseId }).expect(403);
    assert.equal(r.body.code, 'STUDENTS_ONLY');
    await call(root, 'learn', 'enrol', { courseId }).expect(403);
    await call(other, 'learn', 'player', { courseId }).expect(403);
    await call(other, 'account', 'dashboard').expect(403);
    await call(root, 'account', 'dashboard').expect(403);
  });

  test('a learner promoted to Teacher before finishing gets no certificate and loses learner access', async () => {
    const s = await registerStudent('Promoted Before Finish');
    await call(s.a, 'learn', 'enrol', { courseId }).expect(200);
    await call(s.a, 'learn', 'completeLesson', { courseId, lessonId: 'l1' }).expect(200);
    await call(root, 'admin', 'changeRole', { userId: s.id, role: 'teacher' }).expect(200);
    const t = await loginPrivileged(s.email, 'Password123!');
    await call(t, 'learn', 'completeLesson', { courseId, lessonId: 'l2' }).expect(403);
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM certificates WHERE user_id = $1`, [s.id]);
    assert.equal(n, 0);
  });
});

describe('Audit log', () => {
  test('is append-only in the database and exports CSV', async () => {
    await assert.rejects(pool.query(`UPDATE audit_logs SET action = 'x'`), /append-only/);
    await assert.rejects(pool.query(`DELETE FROM audit_logs`), /append-only/);
    await assert.rejects(pool.query(`TRUNCATE audit_logs`), /append-only/);
    const list = (await call(root, 'admin', 'audit', { action: 'auth.login' })).body;
    assert.ok(list.total > 0 && list.entries.every((e) => e.action === 'auth.login' && e.ip));
    const csv = (await call(root, 'admin', 'auditCsv', { action: 'user.role_change' })).body.csv;
    assert.match(csv.split('\r\n')[0], /^id,created_at,actor_email/);
    assert.ok(csv.split('\r\n').length > 1);
  });

  test('notifications are created for key events', async () => {
    const s = await registerStudent('Notified Nia');
    const t = (await makeTeacher('Notify Teacher', root)).a;
    const id = await publishedCourse(t, root, 'Notify Course');
    await call(s.a, 'learn', 'enrol', { courseId: id }).expect(200);
    const n = (await call(s.a, 'account', 'notifications')).body;
    assert.ok(n.unread >= 1 && n.items[0].type === 'enrollment');
    await call(s.a, 'account', 'markNotificationsRead').expect(200);
    assert.equal((await call(s.a, 'account', 'notifications')).body.unread, 0);
  });
});
