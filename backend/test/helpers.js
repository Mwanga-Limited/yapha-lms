// Test harness: real PostgreSQL database (TEST_DATABASE_URL), in-memory mail outbox.
// TEST_DATABASE_URL can be set in backend/.env. The test database is WIPED on every run.
import os from 'node:os';
import path from 'node:path';

(await import('dotenv')).default.config({ quiet: true });
const testUrl = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/elearning_test';
if (process.env.DATABASE_URL && testUrl === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must point to a separate database: the tests erase it.');
}
if (!/test/i.test(new URL(testUrl).pathname)) {
  throw new Error(`Refusing to run: the test database name must contain "test" (got ${new URL(testUrl).pathname.slice(1)}).`);
}
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testUrl;
process.env.MAIL_TRANSPORT = 'memory';
process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'elearning-test-uploads');

const { default: request } = await import('supertest');
const bcrypt = (await import('bcryptjs')).default;
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/scripts/migrate.js');
const { outbox } = await import('../src/lib/mailer.js');

export { pool, outbox };
export const app = createApp();
export const ROOT = { email: 'root@test.dev', password: 'RootPassword123' };

export const TENANT = 'alpha';          // the organisation most tests run in
export const OTHER_TENANT = 'beta';     // a second organisation, for isolation tests
export const SUPER = { email: 'owner@platform.test', password: 'OwnerPassword123' };

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ quiet: true });
  const hash = await bcrypt.hash(ROOT.password, 4);
  for (const slug of [TENANT, OTHER_TENANT]) {
    const { rows: [t] } = await pool.query(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slug, `${slug} org`]);
    await pool.query(`INSERT INTO users (tenant_id, email, password_hash, name, role, is_root, email_verified_at) VALUES ($1,$2,$3,'Root Admin','admin',true, now())`,
      [t.id, ROOT.email, hash]);
  }
  await pool.query(`INSERT INTO users (tenant_id, email, password_hash, name, role, email_verified_at) VALUES (NULL,$1,$2,'Platform Owner','superadmin', now())`,
    [SUPER.email, await bcrypt.hash(SUPER.password, 4)]);
  outbox.length = 0;
}

export const tenantId = async (slug = TENANT) => (await pool.query(`SELECT id FROM tenants WHERE slug = $1`, [slug])).rows[0].id;

export const agent = () => request.agent(app);

/** API path for an endpoint in an organisation ('platform' for the super admin console). */
export const api = (endpoint, slug = TENANT) => (endpoint === 'platform' ? '/api/platform' : `/api/t/${slug}/${endpoint}`);

/** POST {action, data} to an action endpoint (in the default test organisation). */
export const call = (a, endpoint, action, data = {}) => a.post(api(endpoint)).send({ action, data });
/** Same, in a given organisation. */
export const callIn = (slug, a, endpoint, action, data = {}) => a.post(api(endpoint, slug)).send({ action, data });

const lastMailTo = (to, re) => {
  for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].to === to && re.test(outbox[i].text)) return outbox[i].text;
  throw new Error(`no mail to ${to} matching ${re}`);
};
export const tokenFromMail = (to, kind) => lastMailTo(to, new RegExp(kind)).match(new RegExp(`${kind}\\?token=([\\w-]+)`))[1];
export const codeFromMail = (to) => lastMailTo(to, /sign-in code is/).match(/code is (\d{6})/)[1];

export async function registerStudent(name, { verify = true, slug = TENANT } = {}) {
  const email = `${name.toLowerCase().replace(/\W/g, '')}@test.dev`;
  const a = agent();
  const r = await callIn(slug, a, 'auth', 'register', { name, email, password: 'Password123!' });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  if (verify) await callIn(slug, a, 'auth', 'verifyEmail', { token: tokenFromMail(email, 'verify-email') }).expect(200);
  const me = await callIn(slug, a, 'auth', 'me');
  return { a, email, id: me.body.user.id, memberCode: me.body.user.memberCode };
}

/** Password + emailed 2FA code (AD-07). */
export async function loginPrivileged(email, password, slug = TENANT) {
  const a = agent();
  const r = await callIn(slug, a, 'auth', 'login', { email, password });
  if (!r.body.mfa) throw new Error(`expected 2FA step: ${JSON.stringify(r.body)}`);
  const v = await callIn(slug, a, 'auth', 'verifyMfa', { token: r.body.mfa.token, code: codeFromMail(email) });
  if (v.status !== 200) throw new Error(JSON.stringify(v.body));
  return a;
}

export const loginRoot = (slug = TENANT) => loginPrivileged(ROOT.email, ROOT.password, slug);

export async function loginSuper() {
  const a = agent();
  const r = await call(a, 'platform', 'login', SUPER);
  if (!r.body.mfa) throw new Error(JSON.stringify(r.body));
  const v = await call(a, 'platform', 'verifyMfa', { token: r.body.mfa.token, code: codeFromMail(SUPER.email) });
  if (v.status !== 200) throw new Error(JSON.stringify(v.body));
  return a;
}

export async function makeTeacher(name, admin, slug = TENANT) {
  const s = await registerStudent(name, { slug });
  await callIn(slug, s.a, 'account', 'applyTeacher', { bio: 'I have taught this subject for ten years.', expertise: 'Mathematics' }).expect(200);
  const apps = await callIn(slug, admin, 'admin', 'applications', { status: 'pending' });
  const app = apps.body.applications.find((x) => x.email === s.email);
  await callIn(slug, admin, 'admin', 'decideApplication', { id: app.id, decision: 'approve' }).expect(200);
  return { ...s, a: await loginPrivileged(s.email, 'Password123!', slug) };
}

export const sampleContent = () => ({
  sections: [{
    id: 's1', title: 'Getting started',
    items: [
      { id: 'l1', kind: 'lesson', title: 'Welcome', type: 'text', body: 'Hello and welcome.', preview: true },
      { id: 'l2', kind: 'lesson', title: 'Watch this', type: 'video', videoUrl: 'https://example.com/video.mp4' },
      { id: 'q1', kind: 'quiz', title: 'Check-in', questions: [
        { id: 'a', type: 'single', prompt: '2 + 2 = ?', options: [{ id: 'x', text: '4' }, { id: 'y', text: '5' }], correct: ['x'] },
        { id: 'b', type: 'truefalse', prompt: 'The sky is blue', correct: ['true'] },
        { id: 'c', type: 'multi', prompt: 'Even numbers', options: [{ id: 'm', text: '2' }, { id: 'n', text: '3' }, { id: 'o', text: '4' }], correct: ['m', 'o'] },
      ] },
    ],
  }],
  completion: { lessons: ['l1', 'l2'], quizzes: ['q1'] },
});
export const correctAnswers = { a: ['x'], b: ['true'], c: ['m', 'o'] };
export const wrongAnswers = { a: ['y'], b: ['false'], c: ['n'] };

/** Create a complete course and submit it for review. */
export async function submittedCourse(teacher, title = 'Algebra Basics', slug = TENANT) {
  const { body: { id } } = await callIn(slug, teacher, 'courses', 'create', { title }).expect(200);
  await callIn(slug, teacher, 'courses', 'updateMeta', { id, title, summary: 'Learn algebra', category: 'Mathematics', outline: 'Variables, equations', level: 'beginner' }).expect(200);
  await callIn(slug, teacher, 'courses', 'saveContent', { id, content: sampleContent() }).expect(200);
  await callIn(slug, teacher, 'courses', 'submit', { id }).expect(200);
  return id;
}

export async function publishedCourse(teacher, admin, title, slug = TENANT) {
  const id = await submittedCourse(teacher, title, slug);
  const q = await callIn(slug, admin, 'admin', 'reviewQueue');
  const item = q.body.queue.find((x) => x.course.id === id);
  await callIn(slug, admin, 'admin', 'approveCourse', { versionId: item.versionId }).expect(200);
  await callIn(slug, teacher, 'courses', 'publish', { id }).expect(200);
  return id;
}

export const auditCount = async (action, targetId) =>
  (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND ($2::text IS NULL OR target_id = $2)`, [action, targetId ?? null])).rows[0].n;
