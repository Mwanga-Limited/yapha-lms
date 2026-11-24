import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config.js';
import { withScope } from '../db.js';
import { PgRateLimitStore } from '../lib/ratestore.js';
import { HttpError } from '../lib/errors.js';
import { loadUser } from '../lib/security.js';
import { findTenantBySlug } from '../lib/tenant.js';
import { accountRoutes } from './account.js';
import { adminRoutes } from './admin.js';
import { authRoutes } from './auth.js';
import { certificateHandler } from './certificates.js';
import { courseRoutes } from './courses.js';
import { fileHandler, uploadCompleteHandler, uploadHandler, uploadInitHandler, uploadInitMiddleware, uploadMiddleware } from './files.js';
import { learnRoutes } from './learn.js';
import { organisationRoutes } from './organisations.js';
import { paymentRoutes, paystackWebhook } from './payments.js';
import { platformRoutes } from './platform.js';

/**
 * Run a handler inside the request's scope: one transaction, restricted DB role, and either the
 * organisation from the URL or (for /api/platform) the platform-wide super admin view.
 * The result is sent only after the transaction commits; after-commit work (emails) runs last.
 */
const scoped = (handler) => async (req, res) => {
  const tenant = req.tenant ?? null;
  req.afterCommit = [];   // email delivery attempts, queued by lib/mailer.js
  const out = await withScope({ tenant, bypass: !tenant, afterCommit: req.afterCommit }, async () => {
    await loadUser(req, res);
    if (tenant?.status === 'suspended' && !req.user?.isSuper) {
      throw new HttpError(403, 'This organisation is suspended. Contact the platform administrator.', { code: 'TENANT_SUSPENDED' });
    }
    return handler(req, res);
  });
  const deliver = () => Promise.allSettled(req.afterCommit.map((fn) => fn()));
  // Real SMTP: answer first, deliver in the background (a scheduled worker retries whatever does not get through, which
  // matters on Cloud Run, where work after the response may be paused). Test and console transports: finish first, so it is deterministic.
  if (config.mail.transport !== 'smtp') await deliver();
  if (!res.headersSent && out !== undefined) res.json(out);
  if (config.mail.transport === 'smtp') void deliver();
};

/*
 * Rate limiting. Counters are kept per network address AND per organisation, so a classroom or office sharing
 * one IP address is not locked out by traffic elsewhere, and only the actions that can be abused to guess
 * credentials or send email are counted: reads such as `me`, which every page load makes, are not.
 */
const CREDENTIAL_ACTIONS = new Set(['login', 'register', 'google', 'verifyMfa', 'sendMfaEmail', 'requestPasswordReset', 'resetPassword', 'resendVerification']);
const PLATFORM_ACTIONS = new Set(['login', 'verifyMfa', 'sendMfaEmail']);
/** One store per limiter, so counters of different limiters never mix. */
const storeFor = (name) => {
  if (config.rateLimitStore !== 'postgres') return {};
  const store = new PgRateLimitStore(); store.prefix = `${name}:`;
  return { store, passOnStoreError: true };   // if the database hiccups, let the request through rather than lock everyone out
};
const keyFor = (req) => `${ipKeyGenerator(req.ip)}|${req.tenant?.slug ?? '-'}`;

const authLimiter = (actions = CREDENTIAL_ACTIONS, limit = config.rateLimitMax) => rateLimit({
  windowMs: 15 * 60 * 1000, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: keyFor, skip: (req) => !actions.has(req.body?.action), ...storeFor(`auth:${[...actions].join(',')}`),
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

/** /api/:tenant/... — everything an organisation's members use (the original 8 endpoints, per organisation). */
export function tenantApi() {
  const r = express.Router({ mergeParams: true });
  r.use(async (req, _res, next) => {
    const tenant = await findTenantBySlug(String(req.params.tenant || '').toLowerCase());
    if (!tenant) throw new HttpError(404, 'Organisation not found', { code: 'TENANT_NOT_FOUND' });
    req.tenant = tenant;
    next();
  });
  r.post('/auth', authLimiter(), scoped(authRoutes));
  r.post('/account', scoped(accountRoutes));
  r.post('/courses', scoped(courseRoutes));
  r.post('/learn', scoped(learnRoutes));
  r.post('/admin', scoped(adminRoutes));
  r.post('/payments', scoped(paymentRoutes));
  r.post('/payments/webhook', scoped(paystackWebhook));   // from Paystack, signed with the organisation's secret key
  r.post('/upload', ...uploadMiddleware, scoped(uploadHandler));
  r.post('/upload/init', ...uploadInitMiddleware, scoped(uploadInitHandler));
  r.post('/upload/complete', scoped(uploadCompleteHandler));
  r.get('/files/:id', scoped(fileHandler));
  r.get('/certificates/:code', scoped(certificateHandler));
  return r;
}

/** /api/organisations — public: register a new organisation (its first Admin is the person registering). */
export function organisationsApi() {
  const r = express.Router();
  // Registering creates an organisation, so it gets a much tighter limit than other public actions.
  const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: config.orgSignupPerHour, standardHeaders: 'draft-7', legacyHeaders: false,
    skip: (req) => req.body?.action !== 'register', ...storeFor('register'),
    message: { error: 'Too many organisations registered from this network. Please try again in an hour.' } });
  // Typing a web address calls checkAddress on every keystroke (debounced), so it gets its own, more generous limit.
  const addressLimiter = authLimiter(new Set(['checkAddress']), config.rateLimitMax * 3);
  r.post('/', authLimiter(new Set(['register'])), addressLimiter, registerLimiter, scoped(organisationRoutes));
  return r;
}

/** /api/platform — the super admin console (sign-in, all organisations, cross-organisation views). */
export function platformApi() {
  const r = express.Router();
  r.post('/', authLimiter(PLATFORM_ACTIONS), scoped(platformRoutes));
  return r;
}
