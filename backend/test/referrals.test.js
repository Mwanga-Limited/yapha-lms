import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  OTHER_TENANT, TENANT, agent, auditCount, call, callIn, loginRoot, makeTeacher, paystackTestServer, pool, publishedCourse, registerStudent, resetDb,
} from './helpers.js';

let root, teacher, courseA, courseB;
before(async () => {
  await resetDb();
  root = await loginRoot();
  teacher = await makeTeacher('Referral Teacher', root);
  courseA = await publishedCourse(teacher.a, root, 'Referral Course A');
  courseB = await publishedCourse(teacher.a, root, 'Referral Course B');
});
after(async () => { await pool.end(); });

const codeOf = async (member) => (await call(member.a, 'account', 'referrals').expect(200)).body.code;

/** Enrol (pay for) a course, optionally with someone's referral code. Returns the checkout response. */
async function enrolWith(learner, courseId, referralCode, slug = TENANT) {
  const c = await callIn(slug, learner.a, 'payments', 'checkout', { courseId, referralCode });
  if (c.status === 200) await callIn(slug, learner.a, 'payments', 'verify', { reference: c.body.reference }).expect(200);
  return c;
}
const referrerOf = async (learner, courseId) =>
  (await pool.query(`SELECT referred_by FROM enrollments WHERE user_id = $1 AND course_id = $2`, [learner.id, courseId])).rows[0]?.referred_by ?? null;

describe('Referral codes', () => {
  test('every teacher and student has a code, unique across the whole platform', async () => {
    const s = await registerStudent('Coded Student');
    const code = await codeOf(s);
    assert.match(code, /^[A-HJ-KM-NP-Z2-9]{8}$/, '8 characters, no look-alikes such as 0/O or 1/I');
    assert.equal((await call(s.a, 'auth', 'me')).body.user.referralCode, code);
    assert.match((await call(s.a, 'account', 'referrals')).body.link, new RegExp(`/${TENANT}\\?ref=${code}$`));
    assert.ok(await codeOf(teacher));
    await registerStudent('Beta Student', { slug: OTHER_TENANT });
    const { rows } = await pool.query(`SELECT referral_code, count(*)::int AS n FROM users WHERE referral_code IS NOT NULL GROUP BY 1 HAVING count(*) > 1`);
    assert.equal(rows.length, 0, 'no code is used twice, in any organisation');
    await assert.rejects(pool.query(`UPDATE users SET referral_code = $2 WHERE id = $1`, [s.id, 'ABCDEFGH']), /cannot be changed/);
  });

  test('sign-up no longer takes a referral code', async () => {
    const a = agent();
    const r = await call(a, 'auth', 'register', { name: 'Plain Signup', email: 'plain@test.dev', password: 'Password123!', referralCode: 'WHATEVER' });
    assert.equal(r.status, 200, 'the old field is ignored');
    const cols = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'referred_by'`);
    assert.equal(cols.rowCount, 0);
  });
});

describe('Using a referral code when enrolling', () => {
  test("the enrolment records whose code was used; codes aren't case-sensitive", async () => {
    const referrer = await registerStudent('Ada Referrer');
    const code = await codeOf(referrer);
    const learner = await registerStudent('Bola Learner');
    const c = await enrolWith(learner, courseA, ` ${code.toLowerCase()} `);
    assert.equal(c.status, 200);
    assert.equal(await referrerOf(learner, courseA), referrer.id);
    const { rows: [p] } = await pool.query(`SELECT referred_by FROM payments WHERE reference = $1`, [c.body.reference]);
    assert.equal(p.referred_by, referrer.id, 'the payment records it too');
    assert.ok(await auditCount('enrollment.create') > 0);
  });

  test('a teacher can refer too; enrolling without a code works as before', async () => {
    const learner = await registerStudent('Chidi Learner');
    await enrolWith(learner, courseA, await codeOf(teacher)).then((r) => assert.equal(r.status, 200));
    assert.equal(await referrerOf(learner, courseA), teacher.id);
    await enrolWith(learner, courseB, undefined).then((r) => assert.equal(r.status, 200));
    assert.equal(await referrerOf(learner, courseB), null);
  });

  test("a wrong code, your own code, an Admin's code or another organisation's code is refused before paying", async () => {
    const learner = await registerStudent('Dayo Learner');
    let r = await enrolWith(learner, courseA, 'NOTACODE');
    assert.equal(r.status, 400); assert.equal(r.body.code, 'INVALID_REFERRAL');
    r = await enrolWith(learner, courseA, await codeOf(learner));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'OWN_REFERRAL');
    const adminCode = (await pool.query(`SELECT referral_code FROM users WHERE role = 'admin' AND tenant_id = (SELECT id FROM tenants WHERE slug = $1) LIMIT 1`, [TENANT])).rows[0].referral_code;
    r = await enrolWith(learner, courseA, adminCode);
    assert.equal(r.body.code, 'INVALID_REFERRAL', 'referral codes are for teachers and students');
    const beta = await registerStudent('Beta Referrer', { slug: OTHER_TENANT });
    r = await enrolWith(learner, courseA, (await callIn(OTHER_TENANT, beta.a, 'account', 'referrals')).body.code);
    assert.equal(r.body.code, 'INVALID_REFERRAL');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM payments WHERE user_id = $1`, [learner.id])).rows[0].n, 0, 'nothing was charged');
  });

  test("a deactivated member's code stops working", async () => {
    const leaver = await registerStudent('Leaving Lola');
    const code = await codeOf(leaver);
    await call(root, 'admin', 'setActive', { userId: leaver.id, active: false, reason: 'Left the organisation' }).expect(200);
    const r = await enrolWith(await registerStudent('Late Learner'), courseA, code);
    assert.equal(r.body.code, 'INVALID_REFERRAL');
  });

  test('a referral is recorded only when the payment succeeds, and never changes afterwards', async () => {
    const referrer = await registerStudent('Patient Referrer');
    const learner = await registerStudent('Declined Learner');
    const c = await callIn(TENANT, learner.a, 'payments', 'checkout', { courseId: courseA, referralCode: await codeOf(referrer) }).expect(200);
    paystackTestServer.setOutcome(c.body.reference, { status: 'failed' });
    await call(learner.a, 'payments', 'verify', { reference: c.body.reference }).expect(200);
    assert.equal(await referrerOf(learner, courseA), null, 'no enrolment, so no referral');
    await enrolWith(learner, courseA, await codeOf(referrer));
    assert.equal(await referrerOf(learner, courseA), referrer.id);
    const other = await registerStudent('Other Referrer');
    await assert.rejects(pool.query(`UPDATE enrollments SET referred_by = $2 WHERE user_id = $1`, [learner.id, other.id]), /cannot be changed/);
  });
});

describe('Referral lists', () => {
  test('a member sees, per course, how many enrolled with their code and who (part of each email hidden)', async () => {
    const referrer = await registerStudent('Top Referrer');
    const code = await codeOf(referrer);
    const one = await registerStudent('Referee One');
    const two = await registerStudent('Referee Two');
    await enrolWith(one, courseA, code);
    await enrolWith(one, courseB, code);
    await enrolWith(two, courseA, code);
    const mine = (await call(referrer.a, 'account', 'referrals').expect(200)).body;
    assert.equal(mine.count, 3, 'three enrolments in all');
    assert.equal(mine.people, undefined, 'no count of people, only enrolments and courses');
    assert.deepEqual(mine.courses.map((c) => [c.course, c.count]), [['Referral Course A', 2], ['Referral Course B', 1]], 'most first');
    assert.deepEqual(mine.courses[0].referrals.map((r) => r.email), ['r******@test.dev', 'r******@test.dev']);
    assert.ok(JSON.stringify(mine).indexOf('refereeone') === -1, 'emails partly hidden');
  });

  test('the Admin sees every member whose code was used, with counts, and per course how many and who', async () => {
    const r = (await call(root, 'admin', 'referrals').expect(200)).body;
    const top = r.referrers.find((x) => x.name === 'Top Referrer');
    assert.equal(top.count, 3);
    assert.deepEqual(top.courses.map((c) => [c.course, c.count]), [['Referral Course A', 2], ['Referral Course B', 1]]);
    assert.deepEqual(top.courses[0].referrals.map((x) => x.email).sort(), ['refereeone@test.dev', 'refereetwo@test.dev'], 'Admins see full emails');
    assert.equal(r.referrers[0].count, Math.max(...r.referrers.map((x) => x.count)), 'most referrals first');
    assert.ok(r.totals.referrals >= 6);
    const search = (await call(root, 'admin', 'referrals', { q: 'refereetwo@' }).expect(200)).body;
    assert.deepEqual(search.referrers.map((x) => x.name), ['Top Referrer'], 'search finds the referrer by a learner email');
  });

  test('only Admins see the organisation list; admins have no referral list of their own', async () => {
    const s = await registerStudent('Curious Student');
    await call(s.a, 'admin', 'referrals').expect(403);
    await call(teacher.a, 'admin', 'referrals').expect(403);
    await call(root, 'account', 'referrals').expect(403);
    const rootB = await loginRoot(OTHER_TENANT);
    const b = (await callIn(OTHER_TENANT, rootB, 'admin', 'referrals').expect(200)).body;
    assert.equal(b.referrers.length, 0, "alpha's referrals are not visible in beta");
  });
});
