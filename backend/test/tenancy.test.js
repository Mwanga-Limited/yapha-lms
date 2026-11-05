import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  OTHER_TENANT, ROOT, SUPER, TENANT, agent, api, auditCount, call, callIn, codeFromMail, correctAnswers, loginPrivileged,
  loginRoot, loginSuper, makeTeacher, outbox, pool, publishedCourse, registerStudent, resetDb, tenantId, tokenFromMail,
} from './helpers.js';

const A = TENANT;        // "alpha"
const B = OTHER_TENANT;  // "beta"

let rootA, rootB, teacherA, courseA;
before(async () => {
  await resetDb();
  rootA = await loginRoot(A);
  rootB = await loginRoot(B);
  teacherA = (await makeTeacher('Alpha Teacher', rootA, A)).a;
  courseA = await publishedCourse(teacherA, rootA, 'Alpha Only Course', A);
});
after(async () => { await pool.end(); });

/** Run SQL as the restricted app role inside one organisation's scope, like a real request. */
async function asApp(slug, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE elearning_app');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [slug ? await tenantId(slug) : '']);
    return await c.query(sql, params);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

describe('Organisations and member IDs', () => {
  test('every organisation and every member has a unique ID; the same email is a separate account per organisation', async () => {
    const a = await registerStudent('Same Person', { slug: A });
    const b = await registerStudent('Same Person', { slug: B });
    assert.notEqual(a.id, b.id);
    assert.match(a.memberCode, /^ALPHA-\d{6}$/);
    assert.match(b.memberCode, /^BETA-\d{6}$/);
    assert.notEqual(await tenantId(A), await tenantId(B));
    // Separate passwords: changing one does not change the other.
    await callIn(A, a.a, 'account', 'changePassword', { currentPassword: 'Password123!', newPassword: 'AlphaOnly123!' }).expect(200);
    await callIn(B, agent(), 'auth', 'login', { email: a.email, password: 'AlphaOnly123!' }).expect(401);
    await callIn(B, agent(), 'auth', 'login', { email: a.email, password: 'Password123!' }).expect(200);
  });

  test('member IDs never change and accounts cannot move between organisations (database rules)', async () => {
    const s = await registerStudent('Fixed Id', { slug: A });
    await assert.rejects(pool.query(`UPDATE users SET member_code = 'X-1' WHERE id = $1`, [s.id]), /Member IDs cannot be changed/);
    await assert.rejects(pool.query(`UPDATE users SET tenant_id = $2 WHERE id = $1`, [s.id, await tenantId(B)]), /cannot move between organisations/);
  });
});

describe('Isolation between organisations', () => {
  test('a session from one organisation is not accepted by another', async () => {
    const s = await registerStudent('Session Hopper', { slug: A });
    await callIn(A, s.a, 'account', 'dashboard').expect(200);
    await callIn(B, s.a, 'account', 'dashboard').expect(401);
    assert.equal((await callIn(B, s.a, 'auth', 'me')).body.user, null);
  });

  test('courses, enrolments, users, reviews and audit entries of another organisation are invisible', async () => {
    const sB = await registerStudent('Beta Learner', { slug: B });
    // Catalogue and course pages
    const catB = (await callIn(B, agent(), 'courses', 'catalog')).body;
    assert.ok(!catB.courses.some((c) => c.id === courseA));
    await callIn(B, sB.a, 'courses', 'detail', { id: courseA }).expect(404);
    await callIn(B, sB.a, 'courses', 'preview', { courseId: courseA, lessonId: 'l1' }).expect(403);
    await callIn(B, sB.a, 'learn', 'enrol', { courseId: courseA }).expect(404);
    // Admin of B cannot see or touch A
    const usersB = (await callIn(B, rootB, 'admin', 'users')).body.users;
    assert.ok(usersB.every((u) => u.memberCode.startsWith('BETA-')));
    const aUser = (await pool.query(`SELECT u.id FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = $1 AND NOT u.is_root LIMIT 1`, [A])).rows[0].id;
    await callIn(B, rootB, 'admin', 'changeRole', { userId: aUser, role: 'admin' }).expect(404);
    await callIn(B, rootB, 'admin', 'setActive', { userId: aUser, active: false, reason: 'cross-tenant' }).expect(404);
    await callIn(B, rootB, 'courses', 'get', { id: courseA }).expect(404);
    await callIn(B, rootB, 'courses', 'archive', { id: courseA }).expect(404);
    const auditB = (await callIn(B, rootB, 'admin', 'audit')).body;
    const tB = await tenantId(B);
    const ids = auditB.entries.map((e) => e.id);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE id = ANY($1) AND tenant_id <> $2`, [ids, tB]);
    assert.equal(rows[0].n, 0);
    const statsB = (await callIn(B, rootB, 'admin', 'stats')).body.stats;
    assert.equal(statsB.published_courses, 0);
  });

  test('certificates and files of one organisation cannot be fetched through another', async () => {
    const s = await registerStudent('Alpha Graduate', { slug: A });
    await callIn(A, s.a, 'learn', 'enrol', { courseId: courseA }).expect(200);
    await callIn(A, s.a, 'learn', 'completeLesson', { courseId: courseA, lessonId: 'l1' });
    await callIn(A, s.a, 'learn', 'completeLesson', { courseId: courseA, lessonId: 'l2' });
    const r = await callIn(A, s.a, 'learn', 'submitQuiz', { courseId: courseA, quizId: 'q1', answers: correctAnswers }).expect(200);
    const code = r.body.certificate.code;
    const v = await agent().get(`${api('certificates', A)}/${code}`).expect(200);
    assert.equal(v.body.certificate.memberCode, s.memberCode);
    assert.equal(v.body.certificate.issuerName, 'alpha org');
    await agent().get(`${api('certificates', B)}/${code}`).expect(404);

    const up = await rootA.post(api('upload', A)).field('purpose', 'logo').attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'logo.png', contentType: 'image/png' }).expect(200);
    assert.ok(up.body.file.url.startsWith(`/api/t/${A}/files/`));
    await agent().get(`${api('files', B)}/${up.body.file.id}`).expect(404);
  });

  test('PostgreSQL itself enforces isolation (row-level security), not only the application', async () => {
    const tA = await tenantId(A);
    const tB = await tenantId(B);
    const seenByA = (await asApp(A, `SELECT DISTINCT tenant_id FROM users`)).rows.map((r) => r.tenant_id);
    assert.deepEqual(seenByA, [tA]);
    assert.equal((await asApp(A, `SELECT count(*)::int AS n FROM courses WHERE tenant_id = $1`, [tB])).rows[0].n, 0);
    assert.equal((await asApp(null, `SELECT count(*)::int AS n FROM users`)).rows[0].n, 0);            // no organisation: nothing
    assert.equal((await asApp(A, `SELECT count(*)::int AS n FROM tenants`)).rows[0].n, 1);             // only its own row
    await assert.rejects(asApp(A, `INSERT INTO notifications (tenant_id, user_id, type, title) SELECT $1, id, 'x', 'x' FROM users LIMIT 1`, [tB]), /row-level security/);
    await assert.rejects(asApp(A, `UPDATE audit_logs SET action = 'x'`), /permission denied|append-only/);
    await assert.rejects(asApp(A, `DELETE FROM users`), /permission denied/);
  });
});

describe('Per-organisation configuration', () => {
  let teacherB, courseB;
  before(async () => {
    teacherB = (await makeTeacher('Beta Teacher', rootB, B)).a;
    courseB = await publishedCourse(teacherB, rootB, 'Beta Course', B);
  });

  const settings = async (slug, admin, patch) => {
    const cur = (await callIn(slug, admin, 'admin', 'settings')).body.settings;
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { ...cur[k], ...v }])) };
    return callIn(slug, admin, 'admin', 'updateSettings', { settings: next }).expect(200);
  };

  test('quiz rules: pass mark and attempts differ per organisation', async () => {
    await settings(B, rootB, { quiz: { passMark: 60, maxAttempts: 1, lockHours: 2 } });
    const twoOfThree = { a: ['x'], b: ['true'], c: ['m'] };     // 66.67%
    const sB = await registerStudent('Beta Quizzer', { slug: B });
    await callIn(B, sB.a, 'learn', 'enrol', { courseId: courseB }).expect(200);
    const q = (await callIn(B, sB.a, 'learn', 'quiz', { courseId: courseB, quizId: 'q1' })).body.state;
    assert.equal(q.passMark, 60);
    assert.equal(q.maxAttempts, 1);
    const pass = await callIn(B, sB.a, 'learn', 'submitQuiz', { courseId: courseB, quizId: 'q1', answers: twoOfThree }).expect(200);
    assert.equal(pass.body.result.passed, true);                // 66.67% passes at 60%

    const sA = await registerStudent('Alpha Quizzer', { slug: A });
    await callIn(A, sA.a, 'learn', 'enrol', { courseId: courseA }).expect(200);
    const fail = await callIn(A, sA.a, 'learn', 'submitQuiz', { courseId: courseA, quizId: 'q1', answers: twoOfThree }).expect(200);
    assert.equal(fail.body.result.passed, false);              // ...but not at Alpha's default 70%
    assert.equal(fail.body.state.attemptsLeft, 2);

    const sB2 = await registerStudent('Beta Locked', { slug: B });
    await callIn(B, sB2.a, 'learn', 'enrol', { courseId: courseB }).expect(200);
    const locked = await callIn(B, sB2.a, 'learn', 'submitQuiz', { courseId: courseB, quizId: 'q1', answers: { a: ['y'], b: ['false'], c: ['n'] } }).expect(200);
    const hours = (new Date(locked.body.state.lockedUntil) - Date.now()) / 3600e3;
    assert.ok(hours > 1.9 && hours <= 2, 'locked after 1 attempt for 2 hours');
  });

  test('who can join: allowed email domains and invite-only', async () => {
    await settings(A, rootA, { access: { signup: 'open', allowedDomains: ['alpha.edu'] } });
    const bad = await callIn(A, agent(), 'auth', 'register', { name: 'Outsider', email: 'out@gmail.com', password: 'Password123!' }).expect(403);
    assert.equal(bad.body.code, 'EMAIL_DOMAIN');
    await callIn(A, agent(), 'auth', 'register', { name: 'Insider', email: 'in@dept.alpha.edu', password: 'Password123!' }).expect(200);
    await settings(A, rootA, { access: { signup: 'invite', allowedDomains: [] } });
    const r = await callIn(A, agent(), 'auth', 'register', { name: 'Walk In', email: 'walkin@test.dev', password: 'Password123!' }).expect(403);
    assert.equal(r.body.code, 'INVITE_ONLY');

    // An Admin invites; the invitation link sets the password and confirms the email.
    const inv = await callIn(A, rootA, 'admin', 'inviteUser', { name: 'Invited Ifeoma', email: 'ifeoma@test.dev', role: 'student' }).expect(200);
    assert.match(inv.body.user.memberCode, /^ALPHA-/);
    const mail = outbox.findLast((m) => m.to === 'ifeoma@test.dev');
    assert.match(mail.subject, /invited to alpha org/);
    assert.match(mail.text, /\/t\/alpha\/reset-password\?token=/);
    const token = mail.text.match(/token=([\w-]+)/)[1];
    await callIn(B, agent(), 'auth', 'resetPassword', { token, password: 'Invited123!' }).expect(400);     // not valid in another organisation
    await callIn(A, agent(), 'auth', 'resetPassword', { token, password: 'Invited123!' }).expect(200);
    const me = await callIn(A, agent(), 'auth', 'login', { email: 'ifeoma@test.dev', password: 'Invited123!' }).expect(200);
    assert.equal(me.body.user.emailVerified, true);
    await settings(A, rootA, { access: { signup: 'open', allowedDomains: [] } });
  });

  test('sign-in options: two-step sign-in for students when required', async () => {
    const s = await registerStudent('Mfa Student', { slug: B });
    await settings(B, rootB, { auth: { studentMfa: true } });
    const r = await callIn(B, agent(), 'auth', 'login', { email: s.email, password: 'Password123!' }).expect(200);
    assert.ok(r.body.mfa && !r.body.user);
    await callIn(B, agent(), 'auth', 'verifyMfa', { token: r.body.mfa.token, code: codeFromMail(s.email) }).expect(200);
    // Alpha does not require it.
    const a = await registerStudent('Plain Student', { slug: A });
    assert.ok((await callIn(A, agent(), 'auth', 'login', { email: a.email, password: 'Password123!' })).body.user);
    await settings(B, rootB, { auth: { studentMfa: false } });
  });

  test('branding is public, applied to emails, and only Admins change settings', async () => {
    await settings(B, rootB, { branding: { displayName: 'Beta Learning', accentColor: '#123456' } });
    const me = (await callIn(B, agent(), 'auth', 'me')).body.tenant;
    assert.equal(me.name, 'Beta Learning');
    assert.equal(me.branding.accentColor, '#123456');
    await registerStudent('Branded Mail', { slug: B, verify: false });
    const mail = outbox.findLast((m) => m.to === 'brandedmail@test.dev');
    assert.match(mail.from, /^"Beta Learning"/);
    const s = await registerStudent('Not Admin', { slug: B });
    await callIn(B, s.a, 'admin', 'updateSettings', { settings: {} }).expect(403);
    await callIn(B, rootB, 'admin', 'updateSettings', { settings: { quiz: { passMark: 0 } } }).expect(400);
  });
});

describe('Platform super admin', () => {
  test('signs in with two steps, sees every organisation, and tenant users cannot use the console', async () => {
    const r = await call(agent(), 'platform', 'login', SUPER).expect(200);
    assert.ok(r.body.mfa);
    const su = await loginSuper();
    const stats = (await call(su, 'platform', 'stats')).body;
    assert.deepEqual(stats.tenants.map((t) => t.slug).sort(), ['alpha', 'beta', 'yapha']);
    const users = (await call(su, 'platform', 'users', { q: '' })).body.users;
    assert.ok(users.some((u) => u.tenant.slug === A) && users.some((u) => u.tenant.slug === B));
    const onlyB = (await call(su, 'platform', 'users', { tenantId: await tenantId(B) })).body.users;
    assert.ok(onlyB.every((u) => u.tenant.slug === B));
    // Tenant Admins (even with the same email/password) cannot use the console.
    await call(rootA, 'platform', 'stats').expect(401);
    await call(agent(), 'platform', 'login', ROOT).expect(401);
  });

  test('creates an organisation with its first Admin, who is invited and protected', async () => {
    const su = await loginSuper();
    await call(su, 'platform', 'createTenant', { name: 'Reserved', slug: 'platform', adminName: 'X', adminEmail: 'x@test.dev' }).expect(400);
    await call(su, 'platform', 'createTenant', { name: 'Dup', slug: A, adminName: 'X', adminEmail: 'x@test.dev' }).expect(409);
    const c = await call(su, 'platform', 'createTenant', { name: 'Gamma School', slug: 'gamma', adminName: 'Gina Admin', adminEmail: 'gina@gamma.test' }).expect(200);
    assert.match(c.body.admin.memberCode, /^GAMMA-000001$/);
    const token = tokenFromMail('gina@gamma.test', 'reset-password');
    await callIn('gamma', agent(), 'auth', 'resetPassword', { token, password: 'GinaPassword1!' }).expect(200);
    const gina = await loginPrivileged('gina@gamma.test', 'GinaPassword1!', 'gamma');
    const me = (await callIn('gamma', gina, 'auth', 'me')).body.user;
    assert.equal(me.role, 'admin');
    assert.equal(me.isRoot, true);
    assert.equal((await call(su, 'platform', 'tenant', { id: c.body.tenant.id })).body.admins[0].activated, true);
    assert.ok((await auditCount('platform.tenant_create')) >= 1);
  });

  test('acts inside an organisation as an Admin, audited as superadmin, still bound by AD-04', async () => {
    const su = await loginSuper();
    const users = (await callIn(A, su, 'admin', 'users')).body.users;
    assert.ok(users.length > 0 && users.every((u) => u.memberCode.startsWith('ALPHA-')));
    const root = users.find((u) => u.isRoot);
    await callIn(A, su, 'admin', 'changeRole', { userId: root.id, role: 'student' }).expect(403);
    const { rows } = await pool.query(`SELECT actor_role FROM audit_logs WHERE action = 'user.role_change_blocked' ORDER BY id DESC LIMIT 1`);
    assert.equal(rows[0].actor_role, 'superadmin');
    await callIn(A, su, 'account', 'dashboard').expect(403);    // no personal account inside organisations
  });

  test('suspending an organisation blocks its members but not the super admin; audit filters by organisation', async () => {
    const su = await loginSuper();
    const tB = await tenantId(B);
    await call(su, 'platform', 'updateTenant', { id: tB, status: 'suspended' }).expect(200);
    const r = await callIn(B, rootB, 'admin', 'stats').expect(403);
    assert.equal(r.body.code, 'TENANT_SUSPENDED');
    await callIn(B, agent(), 'auth', 'login', { email: ROOT.email, password: ROOT.password }).expect(403);
    await callIn(B, su, 'admin', 'stats').expect(200);
    await callIn(A, rootA, 'admin', 'stats').expect(200);      // other organisations unaffected
    await call(su, 'platform', 'updateTenant', { id: tB, status: 'active' }).expect(200);
    const audit = (await call(su, 'platform', 'audit', { tenantId: tB })).body;
    assert.ok(audit.total > 0 && audit.entries.every((e) => e.tenant_slug === B));
    const platformOnly = (await call(su, 'platform', 'audit', { tenantId: 'platform' })).body;
    assert.ok(platformOnly.entries.every((e) => e.tenant_slug === null));
    assert.ok(platformOnly.entries.some((e) => e.action === 'platform.tenant_suspend'));
  });
});
