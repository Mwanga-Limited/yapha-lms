import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  OTHER_TENANT, TENANT, agent, api, auditCount, call, callIn, config, correctAnswers, loginRoot, makeTeacher, outbox, pool,
  publishedCourse, registerStudent, resetDb, submittedCourse,
} from './helpers.js';
import { signWebhook } from './paystack-test-server.js';
import { PAYSTACK_KEYS, buy, paystackTestServer, tenantId } from './helpers.js';

/** Run SQL as the restricted app role inside one organisation's scope, like a real request. */
async function asApp(slug, sql) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE elearning_app');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [await tenantId(slug)]);
    return await c.query(sql);
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

const KEYS = PAYSTACK_KEYS.alpha;
const KEYS_B = PAYSTACK_KEYS.beta;

let root, teacher;
before(async () => {
  await resetDb();
  // These tests connect Paystack themselves, through the Admin screens.
  await pool.query(`DELETE FROM payment_accounts`);
  root = await loginRoot();
  teacher = (await makeTeacher('Pay Teacher', root)).a;
});
after(async () => { await pool.end(); });

/** A published course with this price (in naira). */
async function pricedCourse(title, price) {
  const id = await publishedCourse(teacher, root, title);
  await call(root, 'courses', 'setPrice', { id, price }).expect(200);
  return id;
}
const enrolledIn = async (s, courseId) =>
  (await pool.query(`SELECT count(*)::int AS n FROM enrollments WHERE user_id = $1 AND course_id = $2 AND status = 'active'`, [s.id, courseId])).rows[0].n;
const webhook = (body, secret = KEYS.secretKey, slug = TENANT) => {
  const raw = JSON.stringify(body);
  return agent().post(`${api('payments', slug)}/webhook`).set('Content-Type', 'application/json').set('x-paystack-signature', signWebhook(secret, raw)).send(raw);
};

describe('Organisation Paystack account (Admin)', () => {
  test('payments need the organisation to connect Paystack first', async () => {
    const id = await pricedCourse('Before Paystack', 5000);
    const d = (await call(agent(), 'courses', 'detail', { id }).expect(200)).body;
    assert.equal(d.paymentsReady, false);
    const s = await registerStudent('Early Buyer');
    const r = await call(s.a, 'payments', 'checkout', { courseId: id }).expect(409);
    assert.equal(r.body.code, 'PAYMENTS_NOT_SET_UP');
  });

  test('only Admins manage the keys; keys are checked; the secret key is never shown or stored in plain text', async () => {
    const s = await registerStudent('Nosy Student');
    await call(s.a, 'payments', 'account').expect(403);
    await call(teacher, 'payments', 'saveAccount', KEYS).expect(403);
    await call(root, 'payments', 'saveAccount', { publicKey: 'pk_test_x', secretKey: KEYS.secretKey }).expect(400);
    await call(root, 'payments', 'saveAccount', { publicKey: KEYS.publicKey, secretKey: 'sk_live_' + 'b'.repeat(40) }).expect(400);   // mixed test/live

    const r = await call(root, 'payments', 'saveAccount', KEYS).expect(200);
    assert.equal(r.body.liveMode, false);
    const a = (await call(root, 'payments', 'account').expect(200)).body;
    assert.equal(a.connected, true);
    assert.equal(a.account.publicKey, KEYS.publicKey);
    assert.equal(a.account.secretKeyHint, 'sk_test_…bbbb');
    assert.equal(a.currency, 'NGN');
    assert.match(a.webhookUrl, /\/api\/alpha\/payments\/webhook$/);
    assert.ok(!JSON.stringify(a).includes(KEYS.secretKey));

    const { rows: [row] } = await pool.query(`SELECT secret_key_enc FROM payment_accounts`);
    assert.ok(!row.secret_key_enc.includes(KEYS.secretKey), 'stored encrypted');
    const logged = (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE new_values::text LIKE '%' || $1 || '%' OR old_values::text LIKE '%' || $1 || '%'`, [KEYS.secretKey])).rows[0].n;
    assert.equal(logged, 0, 'the audit log never holds the secret key');
    assert.ok(await auditCount('payments.account_saved') >= 1);
  });
});

describe('Paystack keys saved under another encryption key', () => {
  test('payments pause with a clear message (no server error) until the Admin enters the keys again', async () => {
    const id = await pricedCourse('Reconnect Course', 1500);
    const { rows: [before] } = await pool.query(`SELECT secret_key_enc FROM payment_accounts WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'alpha')`);
    // As if DATA_ENCRYPTION_KEY changed after the keys were saved: the stored secret can no longer be decrypted.
    await pool.query(`UPDATE payment_accounts SET secret_key_enc = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'alpha')`);

    const a = (await call(root, 'payments', 'account').expect(200)).body;
    assert.equal(a.needsReconnect, true);
    assert.equal((await call(agent(), 'courses', 'detail', { id }).expect(200)).body.paymentsReady, false);
    const s = await registerStudent('Paused Payer');
    const r = await call(s.a, 'payments', 'checkout', { courseId: id }).expect(409);
    assert.equal(r.body.code, 'PAYMENTS_NEED_RECONNECT');

    await call(root, 'payments', 'saveAccount', KEYS).expect(200);
    assert.equal((await call(root, 'payments', 'account').expect(200)).body.needsReconnect, false);
    await buy(s, id);
    assert.ok(before.secret_key_enc);
  });
});

describe('Course prices (teacher suggests, Admin sets)', () => {
  test('the teacher suggests a price; on approval it becomes the price unless the Admin sets another', async () => {
    const id = await submittedCourse(teacher, 'Suggested Price Course');
    // Prices can't change while under review, so suggest it on a second course before submitting.
    const { body: { id: id2 } } = await call(teacher, 'courses', 'create', { title: 'Priced By Teacher' }).expect(200);
    const m = await call(teacher, 'courses', 'updateMeta', { id: id2, title: 'Priced By Teacher', suggestedPrice: 15000 }).expect(200);
    assert.equal(m.body.course.suggestedPrice, 1_500_000, 'kept in kobo');
    assert.equal(m.body.course.price, 0, 'the teacher does not set the real price');

    // First course: approved at the teacher's suggestion (0 here) unless the Admin gives a price.
    const q = (await call(root, 'admin', 'reviewQueue')).body.queue.find((x) => x.course.id === id);
    await call(root, 'admin', 'approveCourse', { versionId: q.versionId, price: 12500 }).expect(200);
    let c = (await call(root, 'courses', 'get', { id })).body.course;
    assert.equal(c.price, 1_250_000);
    assert.equal(c.currency, 'NGN');
  });

  test('approval without a price uses the suggested price', async () => {
    const { body: { id } } = await call(teacher, 'courses', 'create', { title: 'Suggestion Kept' }).expect(200);
    await call(teacher, 'courses', 'updateMeta', { id, title: 'Suggestion Kept', summary: 'x', category: 'Maths', outline: 'y', suggestedPrice: 8000 }).expect(200);
    const { sampleContent } = await import('./helpers.js');
    await call(teacher, 'courses', 'saveContent', { id, content: sampleContent() }).expect(200);
    await call(teacher, 'courses', 'submit', { id }).expect(200);
    const q = (await call(root, 'admin', 'reviewQueue')).body.queue.find((x) => x.course.id === id);
    assert.equal(q.course.suggestedPrice, 800_000, 'the Admin sees the suggestion when reviewing');
    await call(root, 'admin', 'approveCourse', { versionId: q.versionId }).expect(200);
    assert.equal((await call(root, 'courses', 'get', { id })).body.course.price, 800_000);
  });

  test('the Admin can change the price after publishing; teachers and students cannot', async () => {
    const id = await publishedCourse(teacher, root, 'Repriced Course');
    await call(teacher, 'courses', 'setPrice', { id, price: 1 }).expect(403);
    await call(root, 'courses', 'setPrice', { id, price: -5 }).expect(400);
    await call(root, 'courses', 'setPrice', { id, price: 0 }).expect(400);   // every course is paid
    const r = await call(root, 'courses', 'setPrice', { id, price: 20000 }).expect(200);
    assert.equal(r.body.course.price, 2_000_000);
    const cat = (await call(agent(), 'courses', 'catalog', { q: 'Repriced' })).body.courses[0];
    assert.equal(cat.price, 2_000_000, 'the catalogue shows the price');
    assert.ok(await auditCount('course.price_set', id) >= 1);
  });
});

describe('Paying for a course', () => {
  let courseId;
  before(async () => { courseId = await pricedCourse('Paid Accounting', 5000); });

  test('a paid course cannot be opened or enrolled in without paying', async () => {
    const s = await registerStudent('Free Rider');
    const r = await call(s.a, 'learn', 'enrol', { courseId }).expect(402);
    assert.equal(r.body.code, 'PAYMENT_REQUIRED');
    await call(s.a, 'learn', 'lesson', { courseId, lessonId: 'l2' }).expect(403);
    await call(s.a, 'learn', 'player', { courseId }).expect(403);
  });

  test('checkout sends the learner to Paystack for the exact price; teachers, admins and unverified learners cannot buy', async () => {
    const s = await registerStudent('Bola Buyer');
    const r = await call(s.a, 'payments', 'checkout', { courseId }).expect(200);
    assert.match(r.body.authorizationUrl, /^https:\/\/checkout\.paystack\.com\//);
    const sent = paystackTestServer.request(r.body.reference);
    assert.equal(sent.amount, 500_000);
    assert.equal(sent.currency, 'NGN');
    assert.equal(sent.email, s.email);
    assert.match(sent.callback_url, /\/alpha\/payment$/);
    const { rows: [p] } = await pool.query(`SELECT status, amount_minor FROM payments WHERE reference = $1`, [r.body.reference]);
    assert.deepEqual(p, { status: 'pending', amount_minor: 500_000 });
    assert.equal(await enrolledIn(s, courseId), 0, 'no access until Paystack confirms');

    await call(teacher, 'payments', 'checkout', { courseId }).expect(403);
    await call(root, 'payments', 'checkout', { courseId }).expect(403);
    const u = await registerStudent('Unverified Uche', { verify: false });
    await call(u.a, 'payments', 'checkout', { courseId }).expect(403);
  });

  test('after a successful payment the learner has full access (no expiry), gets a receipt, and paying again is refused', async () => {
    const s = await registerStudent('Paid Patience');
    const { body: { reference } } = await call(s.a, 'payments', 'checkout', { courseId }).expect(200);
    const v = await call(s.a, 'payments', 'verify', { reference }).expect(200);
    assert.equal(v.body.payment.status, 'success');
    assert.equal(v.body.courseId, courseId);
    assert.equal(await enrolledIn(s, courseId), 1);
    await call(s.a, 'learn', 'lesson', { courseId, lessonId: 'l2' }).expect(200);
    const { rows: [e] } = await pool.query(`SELECT payment_id FROM enrollments WHERE user_id = $1 AND course_id = $2`, [s.id, courseId]);
    assert.ok(e.payment_id, 'the enrolment records the payment');
    assert.ok(outbox.some((m) => m.to === s.email && /Payment received/.test(m.subject) && /₦5,000/.test(m.text) && m.text.includes(reference)));

    // Checking again changes nothing (the learner refreshes the page).
    await call(s.a, 'payments', 'verify', { reference }).expect(200);
    assert.equal(await enrolledIn(s, courseId), 1);
    assert.equal(await auditCount('payment.success'), Number((await pool.query(`SELECT count(*) FROM payments WHERE status = 'success'`)).rows[0].count));
    const again = await call(s.a, 'payments', 'checkout', { courseId }).expect(409);
    assert.equal(again.body.code, 'ALREADY_ENROLLED');
    const mine = (await call(s.a, 'payments', 'mine').expect(200)).body.payments;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].course.title, 'Paid Accounting');
  });

  test('a declined payment gives no access; the learner can try again', async () => {
    const s = await registerStudent('Declined Dayo');
    const first = (await call(s.a, 'payments', 'checkout', { courseId }).expect(200)).body.reference;
    paystackTestServer.setOutcome(first, { status: 'failed' });
    const v = await call(s.a, 'payments', 'verify', { reference: first }).expect(200);
    assert.equal(v.body.payment.status, 'failed');
    assert.equal(await enrolledIn(s, courseId), 0);
    const second = (await call(s.a, 'payments', 'checkout', { courseId }).expect(200)).body.reference;
    assert.notEqual(second, first);
    assert.equal((await call(s.a, 'payments', 'verify', { reference: second }).expect(200)).body.payment.status, 'success');
    assert.equal(await enrolledIn(s, courseId), 1);
  });

  test('a payment the learner abandoned stays pending and gives no access', async () => {
    const s = await registerStudent('Abandoning Ada');
    const ref = (await call(s.a, 'payments', 'checkout', { courseId }).expect(200)).body.reference;
    paystackTestServer.setOutcome(ref, { status: 'abandoned' });
    assert.equal((await call(s.a, 'payments', 'verify', { reference: ref }).expect(200)).body.payment.status, 'pending');
    assert.equal(await enrolledIn(s, courseId), 0);
  });

  test('a payment for less than the price (or another currency) gives no access', async () => {
    const s = await registerStudent('Short Payer');
    const ref = (await call(s.a, 'payments', 'checkout', { courseId }).expect(200)).body.reference;
    paystackTestServer.setOutcome(ref, { status: 'success', amount: 100 });
    assert.equal((await call(s.a, 'payments', 'verify', { reference: ref }).expect(200)).body.payment.status, 'failed');
    assert.equal(await enrolledIn(s, courseId), 0);
    assert.ok(await auditCount('payment.mismatch') >= 1);

    const ref2 = (await call(s.a, 'payments', 'checkout', { courseId }).expect(200)).body.reference;
    paystackTestServer.setOutcome(ref2, { status: 'success', currency: 'USD' });
    assert.equal((await call(s.a, 'payments', 'verify', { reference: ref2 }).expect(200)).body.payment.status, 'failed');
    assert.equal(await enrolledIn(s, courseId), 0);
  });

  test("a learner cannot use someone else's payment reference", async () => {
    const payer = await registerStudent('Real Payer');
    const ref = (await call(payer.a, 'payments', 'checkout', { courseId }).expect(200)).body.reference;
    const thief = await registerStudent('Reference Thief');
    await call(thief.a, 'payments', 'verify', { reference: ref }).expect(404);
    assert.equal(await enrolledIn(thief, courseId), 0);
  });

  test('raising the price later does not take access away from learners who paid', async () => {
    const id = await pricedCourse('Price Rise Course', 3000);
    const s = await registerStudent('Early Bird');
    const ref = (await call(s.a, 'payments', 'checkout', { courseId: id }).expect(200)).body.reference;
    await call(s.a, 'payments', 'verify', { reference: ref }).expect(200);
    await call(root, 'courses', 'setPrice', { id, price: 9000 }).expect(200);
    await call(s.a, 'learn', 'lesson', { courseId: id, lessonId: 'l1' }).expect(200);
    await call(s.a, 'learn', 'completeLesson', { courseId: id, lessonId: 'l1' }).expect(200);
  });

  test('the learner can complete a paid course and earn the certificate as usual', async () => {
    const id = await pricedCourse('Paid Certificate Course', 1000);
    const s = await registerStudent('Cert Payer');
    const ref = (await call(s.a, 'payments', 'checkout', { courseId: id }).expect(200)).body.reference;
    await call(s.a, 'payments', 'verify', { reference: ref }).expect(200);
    const { watchVideo } = await import('./helpers.js');
    await call(s.a, 'learn', 'completeLesson', { courseId: id, lessonId: 'l1' }).expect(200);
    await watchVideo(s, id, 'l2');
    const r = await call(s.a, 'learn', 'submitQuiz', { courseId: id, quizId: 'q1', answers: correctAnswers }).expect(200);
    assert.ok(r.body.certificate?.code);
  });

  test('every course is paid: no free courses can be submitted, approved, priced, published or joined', async () => {
    // Submitting needs a suggested price.
    const { body: { id } } = await call(teacher, 'courses', 'create', { title: 'No Price Yet' }).expect(200);
    await call(teacher, 'courses', 'updateMeta', { id, title: 'No Price Yet', summary: 'x', category: 'Maths', outline: 'y', suggestedPrice: 0 }).expect(200);
    const { sampleContent } = await import('./helpers.js');
    await call(teacher, 'courses', 'saveContent', { id, content: sampleContent() }).expect(200);
    const sub = await call(teacher, 'courses', 'submit', { id }).expect(422);
    assert.ok(sub.body.problems.includes('Suggest a price (every course is paid)'));
    // The Admin can't set a price of 0.
    await call(root, 'courses', 'setPrice', { id: courseId, price: 0 }).expect(400);

    // A course published before "every course is paid" (price 0): not publishable again, not joinable, not buyable.
    const old = await publishedCourse(teacher, root, 'Old Free Course');
    const s = await registerStudent('Free Learner');
    await buy(s, old);   // a learner who joined before keeps access
    await pool.query(`UPDATE courses SET price_minor = 0 WHERE id = $1`, [old]);
    await call(s.a, 'learn', 'lesson', { courseId: old, lessonId: 'l1' }).expect(200);
    const s2 = await registerStudent('Late Learner');
    assert.equal((await call(s2.a, 'learn', 'enrol', { courseId: old }).expect(409)).body.code, 'NOT_PRICED');
    assert.equal((await call(s2.a, 'payments', 'checkout', { courseId: old }).expect(409)).body.code, 'NOT_PRICED');
    const cat = (await call(agent(), 'courses', 'catalog', { q: 'Old Free Course' })).body;
    assert.equal(cat.total, 0, 'a course without a price is not in the catalogue');
    await call(teacher, 'courses', 'unpublish', { id: old }).expect(200);
    assert.equal((await call(teacher, 'courses', 'publish', { id: old }).expect(409)).body.code, 'PRICE_REQUIRED');
    await call(root, 'courses', 'setPrice', { id: old, price: 2500 }).expect(200);
    await call(teacher, 'courses', 'publish', { id: old }).expect(200);
    await buy(s2, old);
  });
});

describe('Paystack webhook', () => {
  let courseId;
  before(async () => { courseId = await pricedCourse('Webhook Course', 2500); });

  test('a signed charge.success gives access even if the learner never comes back to the site; repeats change nothing', async () => {
    const s = await registerStudent('Closed Tab Tola');
    const ref = (await call(s.a, 'payments', 'checkout', { courseId }).expect(200)).body.reference;
    const event = { event: 'charge.success', data: paystackTestServer.transaction(ref) };
    await webhook(event).expect(200);
    assert.equal(await enrolledIn(s, courseId), 1);
    const mails = outbox.filter((m) => m.to === s.email && /Payment received/.test(m.subject)).length;
    await webhook(event).expect(200);                                  // Paystack retries
    await call(s.a, 'payments', 'verify', { reference: ref }).expect(200);   // and the learner comes back
    assert.equal(await enrolledIn(s, courseId), 1);
    assert.equal(outbox.filter((m) => m.to === s.email && /Payment received/.test(m.subject)).length, mails, 'one receipt');
  });

  test('unsigned or wrongly signed webhooks are refused', async () => {
    const s = await registerStudent('Forged Femi');
    const ref = (await call(s.a, 'payments', 'checkout', { courseId }).expect(200)).body.reference;
    const event = { event: 'charge.success', data: paystackTestServer.transaction(ref) };
    await agent().post(`${api('payments')}/webhook`).send(event).expect(401);
    await webhook(event, 'sk_test_' + 'z'.repeat(40)).expect(401);
    await webhook(event, KEYS_B.secretKey).expect(401);   // another organisation's key
    assert.equal(await enrolledIn(s, courseId), 0);
  });

  test('other events are acknowledged and ignored', async () => {
    await webhook({ event: 'transfer.success', data: { reference: 'nothing' } }).expect(200);
    await webhook({ event: 'charge.success', data: { reference: 'UNKNOWN-REF', status: 'success', amount: 1, currency: 'NGN' } }).expect(200);
  });
});

describe('Payments stay inside their organisation', () => {
  test('each organisation uses its own keys and sees only its own payments', async () => {
    const rootB = await loginRoot(OTHER_TENANT);
    await callIn(OTHER_TENANT, rootB, 'payments', 'saveAccount', KEYS_B).expect(200);
    const teacherB = (await makeTeacher('Beta Teacher', rootB, OTHER_TENANT)).a;
    const idB = await publishedCourse(teacherB, rootB, 'Beta Paid Course', OTHER_TENANT);
    await callIn(OTHER_TENANT, rootB, 'courses', 'setPrice', { id: idB, price: 700 }).expect(200);
    const s = await registerStudent('Beta Buyer', { slug: OTHER_TENANT });
    const ref = (await callIn(OTHER_TENANT, s.a, 'payments', 'checkout', { courseId: idB }).expect(200)).body.reference;
    assert.match(ref, /^BETA-/);
    assert.equal(paystackTestServer.request(ref).amount, 70_000);
    await callIn(OTHER_TENANT, s.a, 'payments', 'verify', { reference: ref }).expect(200);

    const listA = (await call(root, 'payments', 'list', { status: '' }).expect(200)).body;
    assert.ok(!listA.payments.some((p) => p.reference === ref), "alpha's Admin does not see beta's payments");
    const listB = (await callIn(OTHER_TENANT, rootB, 'payments', 'list').expect(200)).body;
    assert.equal(listB.payments.length, 1);
    assert.deepEqual(listB.totals, [{ currency: 'NGN', liveMode: false, amount: 70_000, count: 1 }]);
    // beta's payment, sent to alpha's webhook with beta's key, is refused.
    await webhook({ event: 'charge.success', data: paystackTestServer.transaction(ref) }, KEYS_B.secretKey, TENANT).expect(401);
  });

  test('the database itself keeps payments and Paystack keys apart (row-level security)', async () => {
    const accountsA = await asApp(TENANT, `SELECT tenant_id FROM payment_accounts`);
    assert.equal(accountsA.rows.length, 1);
    assert.equal(accountsA.rows[0].tenant_id, await tenantId(TENANT));
    const paymentsA = await asApp(TENANT, `SELECT DISTINCT tenant_id FROM payments`);
    assert.deepEqual(paymentsA.rows.map((r) => r.tenant_id), [await tenantId(TENANT)]);
    await assert.rejects(asApp(TENANT, `DELETE FROM payments`), /permission denied/, 'payments are never deleted');
  });

  test("the Admin's payments list shows successful payments with the learner and course", async () => {
    const r = (await call(root, 'payments', 'list').expect(200)).body;
    assert.ok(r.payments.length >= 3);
    assert.ok(r.payments.every((p) => p.status === 'success' && p.learner.email && p.course.title));
    const s = await registerStudent('List Student');
    await call(s.a, 'payments', 'list').expect(403);
  });
});
