import { audit } from './audit.js';
import { emails } from './mailer.js';
import { notify } from './notify.js';
import { decryptSecret } from './secrets.js';

/**
 * The organisation's Paystack account (secret key decrypted), or null if it hasn't connected one.
 * If the secret key can't be decrypted (it was saved under a different DATA_ENCRYPTION_KEY), secretKey is null
 * and needsReconnect is true: the Admin must enter the keys again. Payments are refused until then.
 */
export async function paymentAccount(db) {
  const { rows: [a] } = await db.query(`SELECT * FROM payment_accounts`);
  if (!a) return null;
  let secretKey = null;
  try { secretKey = decryptSecret(a.secret_key_enc); } catch { /* saved under another DATA_ENCRYPTION_KEY */ }
  return { publicKey: a.public_key, secretKey, needsReconnect: !secretKey, liveMode: a.live_mode, secretLast4: a.secret_last4, updatedAt: a.updated_at };
}

/** The account, ready to take payments; otherwise a clear 409 for the learner. */
export async function usablePaymentAccount(db, fail) {
  const a = await paymentAccount(db);
  if (!a) fail(409, 'This organisation has not set up payments yet. Please contact your administrator.', { code: 'PAYMENTS_NOT_SET_UP' });
  if (!a.secretKey) fail(409, 'Payments are paused: an administrator needs to re-enter the Paystack keys. Please try again later.', { code: 'PAYMENTS_NEED_RECONNECT' });
  return a;
}

/**
 * Record what Paystack says about a payment and, if it succeeded, enrol the learner (full access, no expiry).
 * Called from the learner's return to the site and from Paystack's webhook, possibly both at once, so it is
 * idempotent: the payment row is locked and a payment already marked successful is left alone.
 * `tx` is Paystack's transaction data from /transaction/verify or the charge.success webhook.
 */
export async function applyPaystackResult(db, ctx, reference, tx) {
  const { rows: [p] } = await db.query(`SELECT * FROM payments WHERE reference = $1 FOR UPDATE`, [reference]);
  if (!p) return null;
  if (p.status === 'success') return { payment: p, newlyPaid: false };

  if (tx?.status !== 'success') {
    // Abandoned/ongoing payments stay pending (the learner may still finish them); failed ones are recorded.
    if (['failed', 'reversed'].includes(tx?.status)) {
      const { rows: [u] } = await db.query(`UPDATE payments SET status = 'failed', failure = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [p.id, String(tx.gateway_response || tx.status).slice(0, 300)]);
      return { payment: u, newlyPaid: false };
    }
    return { payment: p, newlyPaid: false };
  }

  // The amount and currency must be exactly what we asked for.
  if (tx.reference !== p.reference || Number(tx.amount) !== p.amount_minor || String(tx.currency).toUpperCase() !== p.currency) {
    const { rows: [u] } = await db.query(`UPDATE payments SET status = 'failed', failure = 'Amount or currency did not match', updated_at = now() WHERE id = $1 RETURNING *`, [p.id]);
    await audit(db, ctx, { action: 'payment.mismatch', targetType: 'payment', targetId: p.id, actor: null,
      oldValues: { amount: p.amount_minor, currency: p.currency }, newValues: { amount: tx.amount, currency: tx.currency, reference: tx.reference } });
    return { payment: u, newlyPaid: false };
  }

  const { rows: [paid] } = await db.query(
    `UPDATE payments SET status = 'success', paid_at = coalesce($2::timestamptz, now()), channel = $3, failure = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
    [p.id, tx.paid_at || tx.paidAt || null, tx.channel ? String(tx.channel).slice(0, 40) : null]);

  // Enrol (or attach the payment to an existing enrolment).
  const { rows: [e] } = await db.query(
    `INSERT INTO enrollments (user_id, course_id, payment_id) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, course_id) WHERE status = 'active' DO UPDATE SET payment_id = coalesce(enrollments.payment_id, EXCLUDED.payment_id)
     RETURNING *, (xmax = 0) AS inserted`, [p.user_id, p.course_id, p.id]);
  const { rows: [learner] } = await db.query(`SELECT * FROM users WHERE id = $1`, [p.user_id]);
  const { rows: [course] } = await db.query(`SELECT * FROM courses WHERE id = $1`, [p.course_id]);
  await audit(db, ctx, { action: 'payment.success', targetType: 'payment', targetId: p.id, actor: learner,
    newValues: { reference: p.reference, course: course.title, amount: p.amount_minor, currency: p.currency, channel: paid.channel } });
  if (e.inserted) {
    await audit(db, ctx, { action: 'enrollment.create', targetType: 'enrollment', targetId: e.id, actor: learner,
      newValues: { courseId: course.id, course: course.title, paymentId: p.id } });
  }
  await notify(db, learner.id, { type: 'enrollment', title: 'Payment received', body: `You now have full access to ${course.title}.`, link: `/learn/${course.id}` });
  ctx.after(() => emails.paymentReceipt(learner, course, paid));
  return { payment: paid, newlyPaid: true };
}

export const paymentView = (p) => ({
  id: p.id, reference: p.reference, amount: p.amount_minor, currency: p.currency, status: p.status, liveMode: p.live_mode,
  channel: p.channel, paidAt: p.paid_at, failure: p.failure, createdAt: p.created_at,
});
