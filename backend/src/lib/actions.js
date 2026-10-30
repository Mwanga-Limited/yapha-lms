import { z } from 'zod';
import { HttpError } from './errors.js';

/**
 * One endpoint per area: POST { action: "name", data: {...} }.
 * Each handler: { auth: 'public' | 'user' | ['admin', ...], verified?: true, schema?: zod, run(ctx) }
 * The returned function runs inside the request's tenant scope (see routes/index.js), which commits
 * the transaction and then sends the result, so a client never sees "ok" for work that was rolled back.
 */
export function actionEndpoint(handlers) {
  return async (req, res) => {
    const action = req.body?.action;
    const h = typeof action === 'string' && Object.hasOwn(handlers, action) ? handlers[action] : null;
    if (!h) throw new HttpError(400, `Unknown action "${action}"`);

    const user = req.user;
    if (h.auth !== 'public') {
      if (!user) throw new HttpError(401, 'Please sign in');
      // A platform super admin inside an organisation acts as its Admin, but has no personal account there.
      if (user.isSuper && h.auth === 'user') throw new HttpError(403, 'Use the platform console for your own account', { code: 'SUPERADMIN' });
      if (Array.isArray(h.auth) && !h.auth.includes(user.role)) throw new HttpError(403, 'You do not have permission to do this');
      if (h.verified && !user.email_verified_at && !user.isSuper) throw new HttpError(403, 'Please verify your email address first', { code: 'EMAIL_NOT_VERIFIED' });
    }
    const data = h.schema ? h.schema.parse(req.body?.data ?? {}) : (req.body?.data ?? {});
    req.afterCommit ??= [];
    const ctx = {
      req, res, user, data, ip: req.ip, ua: (req.get('user-agent') || '').slice(0, 300),
      after: (fn) => req.afterCommit.push(fn),   // run after the transaction commits (e.g. send emails)
    };
    return (await h.run(ctx)) ?? { ok: true };
  };
}

// ---- shared schema helpers
export const id = z.string().uuid();
export const str = (max = 500) => z.string().trim().max(max);
export const reqStr = (max = 500, min = 1) => z.string().trim().min(min, 'Required').max(max);
/** Password rules. The frontend shows the same list as a live checklist (frontend/src/password.ts). */
export const PASSWORD_RULES = [
  { test: (p) => p.length >= 8, message: 'at least 8 characters' },
  { test: (p) => /[A-Z]/.test(p), message: 'an uppercase letter (A–Z)' },
  { test: (p) => /[a-z]/.test(p), message: 'a lowercase letter (a–z)' },
  { test: (p) => /\d/.test(p), message: 'a number (0–9)' },
  { test: (p) => /[^A-Za-z0-9]/.test(p), message: 'a special character (e.g. ! @ # $ %)' },
];
export const password = z.string().max(200).superRefine((p, ctx) => {
  const missing = PASSWORD_RULES.filter((r) => !r.test(p)).map((r) => r.message);
  if (missing.length) ctx.addIssue({ code: 'custom', message: `Password needs ${missing.join(', ')}` });
});
export const email = z.string().trim().toLowerCase().email('Enter a valid email').max(254);
export const page = z.coerce.number().int().min(1).max(10000).default(1);
