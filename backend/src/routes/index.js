import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { runInContext, withScope } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { loadUser } from '../lib/security.js';
import { findTenantBySlug } from '../lib/tenant.js';
import { accountRoutes } from './account.js';
import { adminRoutes } from './admin.js';
import { authRoutes } from './auth.js';
import { certificateHandler } from './certificates.js';
import { courseRoutes } from './courses.js';
import { fileHandler, uploadHandler, uploadMiddleware } from './files.js';
import { learnRoutes } from './learn.js';
import { platformRoutes } from './platform.js';

/**
 * Run a handler inside the request's scope: one transaction, restricted DB role, and either the
 * organisation from the URL or (for /api/platform) the platform-wide super admin view.
 * The result is sent only after the transaction commits; after-commit work (emails) runs last.
 */
const scoped = (handler) => async (req, res) => {
  const tenant = req.tenant ?? null;
  const out = await withScope({ tenant, bypass: !tenant }, async () => {
    await loadUser(req, res);
    if (tenant?.status === 'suspended' && !req.user?.isSuper) {
      throw new HttpError(403, 'This organisation is suspended. Contact the platform administrator.', { code: 'TENANT_SUSPENDED' });
    }
    return handler(req, res);
  });
  if (!res.headersSent && out !== undefined) res.json(out);
  for (const fn of req.afterCommit ?? []) {
    runInContext({ tenant }, () => Promise.resolve().then(fn).catch((e) => console.error('[after]', e)));
  }
};

const authLimiter = () => rateLimit({ windowMs: 15 * 60 * 1000, limit: config.rateLimitMax, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' } });

/** /api/t/:tenant/... — everything an organisation's members use (the original 8 endpoints, per organisation). */
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
  r.post('/upload', uploadMiddleware, scoped(uploadHandler));
  r.get('/files/:id', scoped(fileHandler));
  r.get('/certificates/:code', scoped(certificateHandler));
  return r;
}

/** /api/platform — the super admin console (sign-in, all organisations, cross-organisation views). */
export function platformApi() {
  const r = express.Router();
  r.post('/', authLimiter(), scoped(platformRoutes));
  return r;
}
