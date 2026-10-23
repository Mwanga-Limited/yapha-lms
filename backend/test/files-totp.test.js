import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { authenticator } from 'otplib';
import { agent, call, loginRoot, makeTeacher, pool, registerStudent, resetDb, sampleContent } from './helpers.js';

let root;
before(async () => { await resetDb(); root = await loginRoot(); });
after(async () => { await pool.end(); });

test('authenticator app (TOTP) 2FA for a Teacher', async () => {
  const t = await makeTeacher('Totp Teacher', root);
  const setup = (await call(t.a, 'account', 'totpSetup').expect(200)).body;
  assert.match(setup.qr, /^data:image\/png;base64,/);
  await call(t.a, 'account', 'totpEnable', { code: '123456' }).expect(400);
  await call(t.a, 'account', 'totpEnable', { code: authenticator.generate(setup.secret) }).expect(200);
  const a = agent();
  const r = await call(a, 'auth', 'login', { email: t.email, password: 'Password123' }).expect(200);
  assert.equal(r.body.mfa.method, 'totp');
  await call(a, 'auth', 'verifyMfa', { token: r.body.mfa.token, code: authenticator.generate(setup.secret) }).expect(200);
  assert.equal((await call(a, 'auth', 'me')).body.user.totpEnabled, true);
});

test('private lesson files need a signed URL from an enrolled session', async () => {
  const t = await makeTeacher('File Teacher', root);
  const up = await t.a.post('/api/upload').field('purpose', 'lesson_file').attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'notes.pdf', contentType: 'application/pdf' }).expect(200);
  const fileId = up.body.file.id;
  assert.equal(up.body.file.url, null);
  const s = await registerStudent('File Student');
  await s.a.post('/api/upload').field('purpose', 'lesson_file').attach('file', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(403);
  await s.a.post('/api/upload').field('purpose', 'photo').attach('file', Buffer.from('x'), { filename: 'x.exe', contentType: 'application/x-msdownload' }).expect(400);

  const content = sampleContent();
  content.sections[0].items.push({ id: 'f1', kind: 'lesson', title: 'Notes', type: 'file', fileId });
  const { body: { id } } = await call(t.a, 'courses', 'create', { title: 'With files' });
  await call(t.a, 'courses', 'updateMeta', { id, title: 'With files', summary: 's', category: 'c', outline: 'o' }).expect(200);
  const saved = await call(t.a, 'courses', 'saveContent', { id, content }).expect(200);
  assert.equal(saved.body.content.sections[0].items[3].fileName, 'notes.pdf');
  await call(t.a, 'courses', 'submit', { id }).expect(200);
  const v = (await call(root, 'admin', 'reviewQueue')).body.queue[0];
  await call(root, 'admin', 'approveCourse', { versionId: v.versionId }).expect(200);
  await call(t.a, 'courses', 'publish', { id }).expect(200);

  await agent().get(`/api/files/${fileId}`).expect(403);
  await call(s.a, 'learn', 'enrol', { courseId: id }).expect(200);
  const l = (await call(s.a, 'learn', 'lesson', { courseId: id, lessonId: 'f1' }).expect(200)).body.lesson;
  assert.match(l.fileUrl, /sig=/);
  const f = await agent().get(l.fileUrl).expect(200);
  assert.equal(f.headers['content-type'], 'application/pdf');
  await agent().get(l.fileUrl.replace(/sig=[^&]+/, 'sig=forged')).expect(403);

  // A teacher cannot reference somebody else's file.
  const other = await makeTeacher('Other File Teacher', root);
  const { body: { id: id2 } } = await call(other.a, 'courses', 'create', { title: 'Thief' });
  await call(other.a, 'courses', 'saveContent', { id: id2, content }).expect(400);
});
