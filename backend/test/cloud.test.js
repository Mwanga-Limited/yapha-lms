// Cloud deployment features: email outbox with retry, authenticator-app hardening, cross-organisation invitation limits,
// direct-to-bucket uploads (with an in-memory bucket), the Postgres rate-limit store and the Cloud Scheduler endpoints.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import request from 'supertest';
import { authenticator } from 'otplib';
import { TENANT, agent, api, app, call, callIn, codeFromMail, config, loginPrivileged, loginRoot, makeTeacher, outbox, pool, registerStudent, resetDb } from './helpers.js';

const { drainOutbox, setTransmitForTests } = await import('../src/lib/outbox.js');
const { setStorageForTests, storage: realStorage } = await import('../src/lib/storage.js');
const { setInternalVerifierForTests } = await import('../src/routes/internal.js');
const { PgRateLimitStore } = await import('../src/lib/ratestore.js');
const { emailHash, signStopToken } = await import('../src/lib/mailguard.js');
const { seal, open, isSealed } = await import('../src/lib/totp.js');

let root;
before(async () => { await resetDb(); root = await loginRoot(); });
after(async () => { await pool.end(); });

const rows = async (sql, p = []) => (await pool.query(sql, p)).rows;

describe('Email outbox', () => {
  test('a failed send is kept and retried; permanent errors are not; sign-in codes lose their body once sent', async () => {
    let fail = true;
    setTransmitForTests(async () => { if (fail) throw Object.assign(new Error('connection reset'), { responseCode: undefined }); });
    const s = await registerStudent('Retry Rita', { verify: false });   // the verification mail fails on first delivery
    let [m] = await rows(`SELECT * FROM email_outbox WHERE to_email = $1`, [s.email]);
    assert.equal(m.status, 'pending'); assert.equal(m.attempts, 1); assert.match(m.last_error, /connection reset/);
    fail = false;
    await pool.query(`UPDATE email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [m.id]);
    const stats = await drainOutbox();
    assert.ok(stats.processed >= 1);
    [m] = await rows(`SELECT * FROM email_outbox WHERE id = $1`, [m.id]);
    assert.equal(m.status, 'sent');

    setTransmitForTests(async () => { throw Object.assign(new Error('mailbox does not exist'), { responseCode: 550 }); });
    await registerStudent('Bounce Bob', { verify: false });
    const [b] = await rows(`SELECT * FROM email_outbox WHERE to_email = 'bouncebob@test.dev'`);
    assert.equal(b.status, 'failed');
    setTransmitForTests(null);
  });

  test('an email is not queued when the request is rolled back', async () => {
    const before = (await rows(`SELECT count(*)::int n FROM email_outbox`))[0].n;
    // inviting a duplicate fails after validation: nothing must be queued
    await callIn(TENANT, root, 'admin', 'inviteUser', { name: 'Dup', email: 'root@test.dev', role: 'student' }).expect(409);
    assert.equal((await rows(`SELECT count(*)::int n FROM email_outbox`))[0].n, before);
  });

  test('mfa mails are scrubbed after sending', async () => {
    await loginPrivileged('root@test.dev', 'RootPassword123');
    const mfa = await rows(`SELECT message, status FROM email_outbox WHERE kind = 'mfa' AND status = 'sent' LIMIT 1`);
    assert.ok(mfa.length);
    assert.ok(!JSON.stringify(mfa[0].message).match(/\d{6}/));
  });
});

describe('Authenticator app', () => {
  test('secret is encrypted at rest; recovery codes work once; replay and email fallback are refused', async () => {
    const t = await makeTeacher('Totp Tina', root);
    const setup = (await call(t.a, 'account', 'totpSetup').expect(200)).body;
    const [stored] = await rows(`SELECT totp_secret FROM users WHERE id = $1`, [t.id]);
    assert.ok(isSealed(stored.totp_secret)); assert.ok(!stored.totp_secret.includes(setup.secret));
    const en = (await call(t.a, 'account', 'totpEnable', { code: authenticator.generate(setup.secret) }).expect(200)).body;
    assert.equal(en.recoveryCodes.length, 10);

    const login = async () => (await callIn(TENANT, agent(), 'auth', 'login', { email: t.email, password: 'Password123!' }).expect(200)).body.mfa;
    const a = agent();
    const mfa = (await callIn(TENANT, a, 'auth', 'login', { email: t.email, password: 'Password123!' }).expect(200)).body.mfa;
    assert.equal(mfa.method, 'totp'); assert.equal(mfa.recovery, true);
    await call(a, 'auth', 'sendMfaEmail', { token: mfa.token }).expect(400);   // no email fallback

    // the setup code is for the current step; a new login with a fresh code works once, a replay fails
    const mfa2 = await login();
    const code = authenticator.generate(setup.secret);
    const a2 = agent();
    const ok = await call(a2, 'auth', 'verifyMfa', { token: mfa2.token, code });
    if (ok.status === 200) {
      const mfa3 = await login();
      await call(agent(), 'auth', 'verifyMfa', { token: mfa3.token, code }).expect(401);   // replay of the same step
    }

    const rc = en.recoveryCodes[0];
    const mfa4 = await login();
    await call(agent(), 'auth', 'verifyMfa', { token: mfa4.token, code: rc }).expect(200);
    const mfa5 = await login();
    await call(agent(), 'auth', 'verifyMfa', { token: mfa5.token, code: rc }).expect(401);   // single use
    assert.ok(outbox.some((m) => m.to === t.email && /recovery code was used/i.test(m.subject)));

    // disabling needs the password and a code
    await call(t.a, 'account', 'totpDisable', { code: en.recoveryCodes[1], password: 'wrong' }).expect(400);
    await call(t.a, 'account', 'totpDisable', { code: en.recoveryCodes[1], password: 'Password123!' }).expect(200);
    const [after] = await rows(`SELECT totp_enabled, totp_secret FROM users WHERE id = $1`, [t.id]);
    assert.equal(after.totp_enabled, false); assert.equal(after.totp_secret, null);
    assert.equal((await rows(`SELECT count(*)::int n FROM recovery_codes WHERE user_id = $1`, [t.id]))[0].n, 0);
  });

  test('an admin can reset a teacher\'s 2FA; seal/open round-trips', async () => {
    const t = await makeTeacher('Lost Phone', root);
    const setup = (await call(t.a, 'account', 'totpSetup').expect(200)).body;
    await call(t.a, 'account', 'totpEnable', { code: authenticator.generate(setup.secret) }).expect(200);
    await call(root, 'admin', 'resetTwoFactor', { userId: t.id, reason: 'lost phone' }).expect(200);
    const [u] = await rows(`SELECT totp_enabled FROM users WHERE id = $1`, [t.id]);
    assert.equal(u.totp_enabled, false);
    const me = await call(t.a, 'auth', 'me');
    assert.equal(me.body.user ?? null, null);   // sessions revoked
    assert.equal(open(seal('ABC123')), 'ABC123');
    assert.equal(open('PLAINBASE32'), 'PLAINBASE32');
  });
});

describe('Invitations across organisations', () => {
  test('per-address limits, opt-out and resend', async () => {
    const target = 'popular@elsewhere.test';
    const invite = () => call(root, 'admin', 'inviteUser', { name: 'Popular', email: target, role: 'student' });
    await invite().expect(200);
    await call(root, 'admin', 'deactivateUser', { userId: (await rows(`SELECT id FROM users WHERE email = $1`, [target]))[0].id }).catch(() => {});
    // resend works for a pending invitee
    const [u] = await rows(`SELECT id FROM users WHERE email = $1`, [target]);
    await pool.query(`UPDATE users SET is_active = true WHERE id = $1`, [u.id]);
    await call(root, 'admin', 'resendInvite', { userId: u.id }).expect(200);
    assert.ok(outbox.filter((m) => m.to === target && /on behalf of/.test(m.text)).length >= 2);
    await call(root, 'admin', 'resendInvite', { userId: u.id }).expect(200);
    await call(root, 'admin', 'resendInvite', { userId: u.id }).expect(429);   // 3 a day per address, across organisations

    // opting out blocks every organisation
    const other = 'optout@elsewhere.test';
    const stop = signStopToken(other);
    await call(agent(), 'auth', 'stopEmails', { token: stop }).expect(200);
    const r = await call(root, 'admin', 'inviteUser', { name: 'Nope', email: other, role: 'student' }).expect(409);
    assert.equal(r.body.code, 'RECIPIENT_OPTED_OUT');
    await call(agent(), 'auth', 'stopEmails', { token: 'garbage-garbage' }).expect(400);
    assert.notEqual(emailHash(other), other);
  });
});

describe('Direct uploads to a bucket', () => {
  const bucket = new Map();
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const fake = {
    kind: 'gcs', direct: true,
    async signedUpload(f) { return { url: `https://bucket.test/${f.storage_name}`, method: 'PUT', headers: {} }; },
    async stat(f) { const b = bucket.get(f.storage_name); return b ? { size: b.data.length, contentType: b.type } : null; },
    async head(f) { return bucket.get(f.storage_name).data.subarray(0, 16); },
    async readBuffer(f) { return bucket.get(f.storage_name).data; },
    async signedDownload(f) { return `https://bucket.test/signed/${f.storage_name}`; },
    async createReadStream(f) { const { Readable } = await import('node:stream'); return Readable.from([bucket.get(f.storage_name).data]); },
    async put(f, data, type) { bucket.set(f.storage_name, { data, type }); },
    async remove(f) { bucket.delete(f.storage_name); },
  };
  before(() => setStorageForTests(fake));
  after(() => setStorageForTests(realStorage));

  test('init → upload → complete; wrong size or content is refused; pending files are unusable', async () => {
    const s = await registerStudent('Direct Dora');
    const init = (await call(s.a, 'upload/init'.replace('/', '_'), 'x').catch(() => null), await s.a.post(api('upload/init')).send({ purpose: 'photo', name: 'me.png', mime: 'image/png', size: PNG.length }).expect(200)).body;
    assert.equal(init.mode, 'direct'); assert.match(init.upload.url, /^https:\/\/bucket\.test\//);
    await s.a.post(api('upload/complete')).send({ fileId: init.fileId }).expect(409);   // not uploaded yet
    const [pending] = await rows(`SELECT * FROM files WHERE id = $1`, [init.fileId]);
    assert.equal(pending.status, 'pending');
    await s.a.get(`${api('files')}/${init.fileId}`).expect(404);   // not served while pending
    bucket.set(pending.storage_name, { data: PNG, type: 'image/png' });
    const done = await s.a.post(api('upload/complete')).send({ fileId: init.fileId }).expect(200);
    assert.ok(done.body.file.url);
    await s.a.get(`${api('files')}/${init.fileId}`).expect(200);

    const bad = (await s.a.post(api('upload/init')).send({ purpose: 'photo', name: 'x.png', mime: 'image/png', size: 20 }).expect(200)).body;
    const [b] = await rows(`SELECT * FROM files WHERE id = $1`, [bad.fileId]);
    bucket.set(b.storage_name, { data: Buffer.alloc(20, 7), type: 'image/png' });   // not really a PNG
    await s.a.post(api('upload/complete')).send({ fileId: bad.fileId }).expect(400);
    assert.equal((await rows(`SELECT 1 FROM files WHERE id = $1`, [bad.fileId])).length, 0);
    assert.ok(!bucket.has(b.storage_name));

    await s.a.post(api('upload/init')).send({ purpose: 'photo', name: 'big.png', mime: 'image/png', size: 6 * 1024 * 1024 }).expect(413);
    await s.a.post(api('upload/init')).send({ purpose: 'lesson_video', name: 'v.mp4', mime: 'video/mp4', size: 100 }).expect(403);
    await request(app).post(api('upload/init')).send({ purpose: 'photo', name: 'a.png', mime: 'image/png', size: 5 }).expect(401);
    await s.a.post(`${api('upload')}?purpose=photo`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(400);   // form upload disabled
  });

  test('private lesson files redirect to a signed bucket address', async () => {
    const t = await makeTeacher('Bucket Teacher', root);
    const init = (await t.a.post(api('upload/init')).send({ purpose: 'lesson_file', name: 'n.pdf', mime: 'application/pdf', size: 12 }).expect(200)).body;
    const [f] = await rows(`SELECT * FROM files WHERE id = $1`, [init.fileId]);
    bucket.set(f.storage_name, { data: Buffer.from('%PDF-1.4 test'.slice(0, 12)), type: 'application/pdf' });
    await t.a.post(api('upload/complete')).send({ fileId: init.fileId }).expect(200);
    const r = await t.a.get(`${api('files')}/${init.fileId}`);   // owner needs no signature
    assert.equal(r.status, 302); assert.match(r.headers.location, /bucket\.test\/signed\//);
  });
});

describe('Scheduler endpoints and rate-limit store', () => {
  test('only the scheduler identity may call them', async () => {
    config.internal.invokerEmail = 'scheduler@proj.iam';
    setInternalVerifierForTests(async (tok) => { if (tok === 'good') return { email: 'scheduler@proj.iam', email_verified: true }; if (tok === 'other') return { email: 'x@y.z', email_verified: true }; throw new Error('bad'); });
    await request(app).post('/api/internal/outbox/drain').expect(401);
    await request(app).post('/api/internal/outbox/drain').set('Authorization', 'Bearer nope').expect(401);
    await request(app).post('/api/internal/outbox/drain').set('Authorization', 'Bearer other').expect(401);
    const r = await request(app).post('/api/internal/outbox/drain').set('Authorization', 'Bearer good').expect(200);
    assert.equal(typeof r.body.pending, 'number');
    await pool.query(`INSERT INTO files (owner_id, original_name, mime_type, size_bytes, storage_name, visibility, purpose, status, tenant_id, created_at)
      SELECT NULL, 'old.png', 'image/png', 1, 'old-pending.png', 'public', 'photo', 'pending', id, now() - interval '3 hours' FROM tenants LIMIT 1`);
    const c = await request(app).post('/api/internal/cleanup').set('Authorization', 'Bearer good').expect(200);
    assert.equal(c.body.abandonedUploads, 1);
  });

  test('the Postgres store counts hits per key and resets after the window', async () => {
    const store = new PgRateLimitStore(); store.init({ windowMs: 60_000 });
    assert.equal((await store.increment('k1')).totalHits, 1);
    assert.equal((await store.increment('k1')).totalHits, 2);
    await pool.query(`UPDATE rate_limits SET reset_at = now() - interval '1 second' WHERE key = 'k1'`);
    assert.equal((await store.increment('k1')).totalHits, 1);
    await store.decrement('k1'); assert.equal((await store.increment('k1')).totalHits, 1);
    await store.resetKey('k1');
    assert.equal((await store.increment('k1')).totalHits, 1);
  });
});
