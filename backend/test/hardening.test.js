// Pre-deployment hardening: rate limiting, account takeover, upload gate, invitation limits, URL schemes,
// health/metrics, configuration checks and migrations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import request from 'supertest';
import {
  TENANT, OTHER_TENANT, agent, api, app, call, callIn, config, loginPrivileged, loginRoot, makeTeacher, outbox, pool,
  registerStudent, resetDb, sampleContent, tokenFromMail,
} from './helpers.js';

// Loaded after the helpers: they set the test environment first (a static import could run before that).
const { createApp } = await import('../src/app.js');
const { setGoogleVerifierForTests } = await import('../src/lib/google.js');
const { migrate, pendingMigrations } = await import('../src/scripts/migrate.js');

let rootA;
before(async () => { await resetDb(); rootA = await loginRoot(TENANT); });
after(async () => { await pool.end(); });

const uploadedFiles = () => fs.readdirSync(config.uploadDir).length;

describe('Rate limiting (F-01)', () => {
  test('page-load reads are never limited, credential actions are, and organisations do not share a counter', async () => {
    const saved = config.rateLimitMax;
    config.rateLimitMax = 5;                       // the limiter reads this when the app is created
    const limited = createApp();
    config.rateLimitMax = saved;
    const post = (slug, body) => request(limited).post(`/api/${slug}/auth`).send(body);
    for (let i = 0; i < 40; i++) await post(TENANT, { action: 'me' }).expect(200);   // 8x the limit: still fine
    for (let i = 0; i < 5; i++) await post(TENANT, { action: 'login', data: { email: `nobody${i}@test.dev`, password: 'x' } }).expect(401);
    await post(TENANT, { action: 'login', data: { email: 'nobody9@test.dev', password: 'x' } }).expect(429);
    await post(TENANT, { action: 'me' }).expect(200);                                  // reads still work for everyone behind that address
    await post(OTHER_TENANT, { action: 'login', data: { email: 'nobody@test.dev', password: 'x' } }).expect(401);   // another organisation: own counter
  });
});

describe('Google sign-in cannot take over an unverified account (F-02)', () => {
  test('the password, authenticator app and sessions of the unverified registrant are removed', async () => {
    setGoogleVerifierForTests(async (credential) => ({ sub: `sub-${credential}`, email: 'victim@test.dev', email_verified: true, name: 'Victim' }));
    // An attacker registers the victim's address with a password they know. Nobody has verified it.
    const attacker = agent();
    await callIn(TENANT, attacker, 'auth', 'register', { name: 'Mallory', email: 'victim@test.dev', password: 'Attacker123!' }).expect(200);
    assert.ok((await callIn(TENANT, attacker, 'auth', 'me')).body.user);
    // The real owner later signs in with Google.
    const victim = agent();
    const g = await callIn(TENANT, victim, 'auth', 'google', { credential: 'victim-credential' }).expect(200);
    assert.equal(g.body.notice, 'PASSWORD_CLEARED');
    assert.equal(g.body.user.emailVerified, true);
    // The attacker is locked out: password, existing session and any pending links.
    await callIn(TENANT, agent(), 'auth', 'login', { email: 'victim@test.dev', password: 'Attacker123!' }).expect(401);
    assert.equal((await callIn(TENANT, attacker, 'auth', 'me')).body.user, null);
    await callIn(TENANT, agent(), 'auth', 'verifyEmail', { token: tokenFromMail('victim@test.dev', 'verify-email') }).expect(400);
    const { rows: [u] } = await pool.query(`SELECT password_hash, totp_enabled FROM users WHERE lower(email) = 'victim@test.dev'`);
    assert.equal(u.password_hash, null);
    assert.equal(u.totp_enabled, false);
    assert.equal((await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'auth.account_claimed'`)).rowCount, 1);
    // The Google owner is still signed in.
    assert.ok((await callIn(TENANT, victim, 'auth', 'me')).body.user);
  });

  test('a verified account keeps its password when Google is linked', async () => {
    setGoogleVerifierForTests(async () => ({ sub: 'sub-verified', email: 'verified@test.dev', email_verified: true, name: 'Verified' }));
    await registerStudent('Verified');
    const g = await callIn(TENANT, agent(), 'auth', 'google', { credential: 'x-credential' }).expect(200);
    assert.equal(g.body.notice, undefined);
    await callIn(TENANT, agent(), 'auth', 'login', { email: 'verified@test.dev', password: 'Password123!' }).expect(200);
  });
});

describe('Uploads are checked before the body is read (F-03)', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = (n) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - 8), 1)]);

  test('no session, no write: nothing reaches the disk', async () => {
    const before = uploadedFiles();
    await request(app).post(`${api('upload')}?purpose=photo`).set('Cookie', `yapha_${TENANT}=junk`).attach('file', file(1024), { filename: 'a.png', contentType: 'image/png' }).expect(401);
    await request(app).post(`${api('upload')}?purpose=photo`).attach('file', file(1024), { filename: 'a.png', contentType: 'image/png' }).expect(401);
    assert.equal(uploadedFiles(), before);
  });

  test('the size cap of each purpose is applied up front; the purpose must be known', async () => {
    const before = uploadedFiles();
    const s = await registerStudent('Uploader');
    await s.a.post(`${api('upload')}?purpose=photo`).attach('file', file(6 * 1024 * 1024), { filename: 'big.png', contentType: 'image/png' }).expect(413);
    await s.a.post(`${api('upload')}?purpose=nonsense`).attach('file', file(10), { filename: 'a.png', contentType: 'image/png' }).expect(400);
    await s.a.post(`${api('upload')}?purpose=photo`).attach('file', file(100), { filename: 'ok.png', contentType: 'image/png' }).expect(200);
    await s.a.post(`${api('upload')}?purpose=lesson_video`).attach('file', file(10), { filename: 'v.mp4', contentType: 'video/mp4' }).expect(403);   // students cannot upload lesson media
    assert.equal(uploadedFiles(), before + 1);
  });

  test('an organisation cannot exceed its storage quota', async () => {
    const saved = config.orgStorageMb;
    config.orgStorageMb = 0.0001;   // about 100 bytes
    try {
      const s = await registerStudent('Quota');
      const r = await s.a.post(`${api('upload')}?purpose=photo`).attach('file', file(2000), { filename: 'q.png', contentType: 'image/png' }).expect(413);
      assert.equal(r.body.code, 'STORAGE_FULL');
    } finally { config.orgStorageMb = saved; }
  });
});

describe('Invitations cannot be used as an email relay (F-04)', () => {
  test('an unverified Admin cannot invite; a verified one is capped per day', async () => {
    const org = (action, data) => agent().post('/api/organisations').send({ action, data });
    await org('register', { organisationName: 'Relay School', slug: 'relay', name: 'Rae Admin', email: 'rae@relay.test', password: 'RaePassword1!' }).expect(200);
    const rae = await loginPrivileged('rae@relay.test', 'RaePassword1!', 'relay');
    const invite = (i) => callIn('relay', rae, 'admin', 'inviteUser', { name: `Guest ${i}`, email: `guest${i}@elsewhere.test`, role: 'student' });
    const refused = await invite(0).expect(403);
    assert.equal(refused.body.code, 'EMAIL_NOT_VERIFIED');
    await callIn('relay', agent(), 'auth', 'verifyEmail', { token: tokenFromMail('rae@relay.test', 'verify-email') }).expect(200);
    // A new organisation may send config.newOrgInvitesPerDay invitations in its first 24 hours.
    for (let i = 0; i < config.newOrgInvitesPerDay; i++) await invite(i).expect(200);
    const capped = await invite(99).expect(429);
    assert.equal(capped.body.code, 'INVITE_LIMIT');
    assert.equal(outbox.filter((m) => /invited/i.test(m.subject) && /elsewhere\.test/.test(m.to)).length, config.newOrgInvitesPerDay);
    // Once the organisation is a day old the normal (higher) cap applies.
    await pool.query(`UPDATE tenants SET created_at = now() - interval '2 days' WHERE slug = 'relay'`);
    await invite(100).expect(200);
  });
});

describe('Links are http(s) only (F-18)', () => {
  test('credential links and lesson video links reject javascript: and data: URLs', async () => {
    const s = await registerStudent('Linker');
    const apply = (credentialUrl) => callIn(TENANT, s.a, 'account', 'applyTeacher', { bio: 'I have taught this subject for ten years.', expertise: 'Maths', credentialUrl });
    await apply('javascript:alert(document.domain)').expect(400);
    await apply('data:text/html,<script>1</script>').expect(400);
    const teacher = await makeTeacher('Link Teacher', rootA);
    const { body: { id } } = await callIn(TENANT, teacher.a, 'courses', 'create', { title: 'Links' }).expect(200);
    const bad = sampleContent();
    bad.sections[0].items[1].videoUrl = 'javascript:alert(1)';
    await callIn(TENANT, teacher.a, 'courses', 'saveContent', { id, content: bad }).expect(400);
    await callIn(TENANT, teacher.a, 'courses', 'saveContent', { id, content: sampleContent() }).expect(200);
    await apply('https://example.com/credential').expect(200);
  });
});

describe('Google sign-in popup', () => {
  test('the opener policy lets the Google popup hand its credential back to the page', async () => {
    const r = await request(app).get('/api/health');
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin-allow-popups');
  });
});

describe('Observability', () => {
  test('every response carries a request id, and errors repeat it', async () => {
    const ok = await request(app).post(api('auth')).send({ action: 'me' });
    assert.match(ok.headers['x-request-id'], /^[\w-]{8,64}$/);
    const bad = await request(app).post(api('auth')).set('X-Request-Id', 'client-id-12345').send({ action: 'nope' }).expect(400);
    assert.equal(bad.body.requestId, 'client-id-12345');
    assert.equal(bad.headers['x-request-id'], 'client-id-12345');
  });

  test('health reports each check; metrics are off without a token and protected with one', async () => {
    const h = await request(app).get('/api/health').expect(200);
    assert.deepEqual(h.body, { ok: true, checks: { database: true, migrations: true, storage: true } });
    await request(app).get('/api/metrics').expect(404);
    config.metricsToken = 'test-metrics-token';
    try {
      await request(app).get('/api/metrics').expect(401);
      await request(app).get('/api/metrics').set('Authorization', 'Bearer wrong-token-value').expect(401);
      const m = await request(app).get('/api/metrics').set('Authorization', 'Bearer test-metrics-token').expect(200);
      assert.match(m.text, /http_requests_total\{status="2xx"\}/);
      assert.match(m.text, /db_pool_connections/);
    } finally { config.metricsToken = ''; }
  });
});

describe('Production configuration is validated (F-11)', () => {
  const run = (env) => spawnSync(process.execPath, ['-e', "import('./src/config.js')"], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: 'postgres://x@localhost/x', ...env },
  });
  const good = { JWT_SECRET: 'x'.repeat(10) + 'Zq8!vR2$kLp0wN5#tY7&bH3@mC6^dF9*', MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.test', TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), DATA_ENCRYPTION_KEY: 'q'.repeat(40) };

  test('weak secrets and the console mail transport are refused', () => {
    assert.equal(run(good).status, 0);
    assert.match(run({ ...good, JWT_SECRET: 'short' }).stderr, /JWT_SECRET must be/);
    assert.match(run({ ...good, JWT_SECRET: 'change-me-to-a-long-random-string-xxxxxxxxxx' }).stderr, /JWT_SECRET must be/);
    assert.match(run({ ...good, MAIL_TRANSPORT: 'console' }).stderr, /MAIL_TRANSPORT must be smtp/);
    assert.match(run({ JWT_SECRET: good.JWT_SECRET }).stderr, /MAIL_TRANSPORT must be smtp/);
    assert.match(run({ ...good, TOTP_ENCRYPTION_KEY: '' }).stderr, /TOTP_ENCRYPTION_KEY/);
    assert.match(run({ ...good, TOTP_ENCRYPTION_KEY: 'c2hvcnQ=' }).stderr, /32 random bytes/);
    assert.match(run({ ...good, STORAGE_DRIVER: 'gcs' }).stderr, /GCS_BUCKET is required/);
    assert.equal(run({ ...good, STORAGE_DRIVER: 'gcs', GCS_BUCKET: 'b' }).status, 0);
  });
});

describe('Migrations (F-13)', () => {
  test('two deployments migrating at once do not collide, and the app role is verified', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    assert.ok((await pendingMigrations()).length > 0);
    await Promise.all([migrate({ quiet: true }), migrate({ quiet: true })]);
    assert.deepEqual(await pendingMigrations(), []);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    assert.equal(rows[0].n, fs.readdirSync(new URL('../migrations', import.meta.url)).filter((f) => f.endsWith('.sql')).length);   // each applied exactly once
  });
});
