import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { actionEndpoint, id, page, str } from '../lib/actions.js';
import { audit } from '../lib/audit.js';
import { fail, notFound } from '../lib/errors.js';
import { KEY_RE, PaystackError, initializeTransaction, validWebhookSignature, verifyTransaction } from '../lib/paystack.js';
import { applyPaystackResult, paymentAccount, paymentView, usablePaymentAccount } from '../lib/payments.js';
import { encryptSecret } from '../lib/secrets.js';
import { findReferrer } from '../lib/referrals.js';
import { currentTenant, settingsOf } from '../lib/tenant.js';

const ADMIN = ['admin'];
const PAGE = 25;
const newReference = () => `${currentTenant().slug.slice(0, 10).toUpperCase()}-${crypto.randomBytes(9).toString('base64url')}`;

const paystack = async (fn) => {
  try { return await fn(); } catch (e) {
    if (e instanceof PaystackError) fail(502, e.message, { code: 'PAYSTACK_ERROR' });
    throw e;
  }
};

export const paymentRoutes = actionEndpoint({
  // ------------------------------------------------------------- learner: pay for a course
  /** Start paying for a course: returns Paystack's checkout page to send the learner to. */
  checkout: {
    auth: ['student'],
    verified: true,
    // referralCode: optional, someone's referral code entered when enrolling (or filled in from their referral link).
    schema: z.object({ courseId: id, referralCode: z.string().trim().max(40).optional() }),
    run: async (ctx) => {
      const { rows: [c] } = await query(`SELECT * FROM courses WHERE id = $1`, [ctx.data.courseId]);
      if (!c) notFound('Course');
      if (c.status !== 'published') fail(409, 'This course is not open for enrolment');
      if (c.price_minor <= 0) fail(409, 'This course is not available yet: it has no price', { code: 'NOT_PRICED' });
      const { rows: [e] } = await query(`SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2 AND status = 'active'`, [ctx.user.id, c.id]);
      if (e) fail(409, 'You already have access to this course', { code: 'ALREADY_ENROLLED' });
      const referrer = await findReferrer({ query }, ctx.data.referralCode, ctx.user.id);
      const account = await usablePaymentAccount({ query }, fail);

      const tenant = currentTenant();
      const currency = settingsOf(tenant).payments.currency;
      const reference = newReference();
      const { rows: [p] } = await query(
        `INSERT INTO payments (user_id, course_id, reference, amount_minor, currency, live_mode, referred_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ctx.user.id, c.id, reference, c.price_minor, currency, account.liveMode, referrer?.id ?? null]);
      const init = await paystack(() => initializeTransaction(account.secretKey, {
        email: ctx.user.email, amount: c.price_minor, currency, reference,
        callbackUrl: `${config.appUrl}/${tenant.slug}/payment`,   // Paystack adds ?trxref=…&reference=…
        metadata: { organisation: tenant.slug, courseId: c.id, course: c.title, userId: ctx.user.id, paymentId: p.id },
      }));
      await audit({ query }, ctx, { action: 'payment.start', targetType: 'payment', targetId: p.id,
        newValues: { reference, course: c.title, amount: c.price_minor, currency, referredBy: referrer?.id ?? null } });
      return { authorizationUrl: init.authorization_url, reference };
    },
  },

  /** Back from Paystack: ask Paystack how the payment went (the browser's word is never trusted). */
  verify: {
    auth: ['student'],
    schema: z.object({ reference: str(100).min(1) }),
    run: async (ctx) => {
      const { rows: [p] } = await query(`SELECT * FROM payments WHERE reference = $1 AND user_id = $2`, [ctx.data.reference, ctx.user.id]);
      if (!p) notFound('Payment');
      let result = { payment: p };
      if (p.status !== 'success') {
        const account = await usablePaymentAccount({ query }, fail);
        const data = await paystack(() => verifyTransaction(account.secretKey, p.reference));
        result = await tx((db) => applyPaystackResult(db, ctx, p.reference, data));
      }
      const { rows: [c] } = await query(`SELECT slug FROM courses WHERE id = $1`, [p.course_id]);
      return { payment: paymentView(result.payment), courseId: p.course_id, courseSlug: c.slug };
    },
  },

  /** The learner's own payments (receipts). */
  mine: {
    auth: ['student'],
    run: async (ctx) => {
      const { rows } = await query(
        `SELECT p.*, c.title AS course_title, c.slug AS course_slug FROM payments p JOIN courses c ON c.id = p.course_id
          WHERE p.user_id = $1 AND p.status = 'success' ORDER BY p.paid_at DESC`, [ctx.user.id]);
      return { payments: rows.map((p) => ({ ...paymentView(p), course: { id: p.course_id, slug: p.course_slug, title: p.course_title } })) };
    },
  },

  // ------------------------------------------------------------- Admin: the organisation's Paystack account
  account: {
    auth: ADMIN,
    run: async () => {
      const a = await paymentAccount({ query });
      const tenant = currentTenant();
      return {
        connected: !!a,
        needsReconnect: !!a?.needsReconnect,   // keys saved under another DATA_ENCRYPTION_KEY: enter them again
        account: a ? { publicKey: a.publicKey, secretKeyHint: `sk_${a.liveMode ? 'live' : 'test'}_…${a.secretLast4}`, liveMode: a.liveMode, updatedAt: a.updatedAt } : null,
        currency: settingsOf(tenant).payments.currency,
        webhookUrl: `${config.appUrl}/api/${tenant.slug}/payments/webhook`,
      };
    },
  },

  saveAccount: {
    auth: ADMIN,
    schema: z.object({
      publicKey: z.string().trim().regex(KEY_RE.public, 'Enter your Paystack public key (pk_test_… or pk_live_…)'),
      secretKey: z.string().trim().regex(KEY_RE.secret, 'Enter your Paystack secret key (sk_test_… or sk_live_…)'),
    }),
    run: async (ctx) => {
      const { publicKey, secretKey } = ctx.data;
      const liveMode = publicKey.startsWith('pk_live_');
      if (liveMode !== secretKey.startsWith('sk_live_')) fail(400, 'Use a public and secret key from the same mode (both test or both live)');
      const before = await paymentAccount({ query });
      await query(
        `INSERT INTO payment_accounts (public_key, secret_key_enc, secret_last4, live_mode, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id) DO UPDATE SET public_key = $1, secret_key_enc = $2, secret_last4 = $3, live_mode = $4, updated_by = $5, updated_at = now()`,
        [publicKey, encryptSecret(secretKey), secretKey.slice(-4), liveMode, ctx.user.isSuper ? null : ctx.user.id]);
      // The audit log never holds the secret key.
      await audit({ query }, ctx, { action: 'payments.account_saved', targetType: 'tenant', targetId: currentTenant().id,
        oldValues: before ? { publicKey: before.publicKey, liveMode: before.liveMode } : null, newValues: { publicKey, liveMode } });
      return { ok: true, liveMode };
    },
  },

  removeAccount: {
    auth: ADMIN,
    run: async (ctx) => {
      const { rowCount } = await query(`DELETE FROM payment_accounts`);
      if (rowCount) await audit({ query }, ctx, { action: 'payments.account_removed', targetType: 'tenant', targetId: currentTenant().id });
      return { ok: true };
    },
  },

  // ------------------------------------------------------------- Admin: payments received
  list: {
    auth: ADMIN,
    schema: z.object({ status: z.enum(['', 'pending', 'success', 'failed']).default('success'), page }),
    run: async ({ data }) => {
      const params = [data.status, PAGE, (data.page - 1) * PAGE];
      const where = `($1 = '' OR p.status = $1)`;
      const [list, total, sums] = await Promise.all([
        query(`SELECT p.*, u.name, u.email, c.title AS course_title FROM payments p JOIN users u ON u.id = p.user_id JOIN courses c ON c.id = p.course_id
                WHERE ${where} ORDER BY coalesce(p.paid_at, p.created_at) DESC LIMIT $2 OFFSET $3`, params),
        query(`SELECT count(*)::int AS n FROM payments p WHERE ${where}`, [data.status]),
        query(`SELECT currency, live_mode, sum(amount_minor)::bigint AS total, count(*)::int AS n FROM payments WHERE status = 'success' GROUP BY currency, live_mode`),
      ]);
      return {
        payments: list.rows.map((p) => ({ ...paymentView(p), learner: { name: p.name, email: p.email }, course: { id: p.course_id, title: p.course_title } })),
        total: total.rows[0].n, pageSize: PAGE,
        totals: sums.rows.map((r) => ({ currency: r.currency, liveMode: r.live_mode, amount: Number(r.total), count: r.n })),
      };
    },
  },
});

/**
 * POST /api/<organisation>/payments/webhook — Paystack tells us about payments, even if the learner
 * never comes back to the site. Only requests signed with the organisation's secret key are accepted.
 */
export async function paystackWebhook(req, res) {
  const account = await paymentAccount({ query });
  if (!account?.secretKey || !validWebhookSignature(account.secretKey, req.rawBody, req.get('x-paystack-signature'))) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }
  const event = req.body;
  req.afterCommit ??= [];
  const ctx = { req, res, user: null, ip: req.ip, ua: 'Paystack webhook', after: (fn) => req.afterCommit.push(fn) };
  if (event?.event === 'charge.success' && typeof event.data?.reference === 'string') {
    await tx((db) => applyPaystackResult(db, ctx, event.data.reference, event.data));
  }
  return { ok: true };   // other events are acknowledged and ignored
}
