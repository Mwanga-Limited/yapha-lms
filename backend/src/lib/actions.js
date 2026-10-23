import { z } from 'zod';
import { HttpError } from './errors.js';

/**
 * One endpoint per area: POST { action: "name", data: {...} }.
 * Each handler: { auth: 'public' | 'user' | ['admin', ...], verified?: true, schema?: zod, run(ctx) }
 */
export function actionEndpoint(handlers) {
  return async (req, res) => {
    const action = req.body?.action;
    const h = typeof action === 'string' && Object.hasOwn(handlers, action) ? handlers[action] : null;
    if (!h) throw new HttpError(400, `Unknown action "${action}"`);

    const user = req.user;
    if (h.auth !== 'public') {
      if (!user) throw new HttpError(401, 'Please sign in');
      if (Array.isArray(h.auth) && !h.auth.includes(user.role)) throw new HttpError(403, 'You do not have permission to do this');
      if (h.verified && !user.email_verified_at) throw new HttpError(403, 'Please verify your email address first', { code: 'EMAIL_NOT_VERIFIED' });
    }
    const data = h.schema ? h.schema.parse(req.body?.data ?? {}) : (req.body?.data ?? {});
    const after = [];
    const ctx = {
      req, res, user, data, ip: req.ip, ua: (req.get('user-agent') || '').slice(0, 300),
      after: (fn) => after.push(fn),   // run after success (e.g. send emails after commit)
    };
    const result = await h.run(ctx);
    res.json(result ?? { ok: true });
    for (const fn of after) Promise.resolve().then(fn).catch((e) => console.error('[after]', e));
  };
}

// ---- shared schema helpers
export const id = z.string().uuid();
export const str = (max = 500) => z.string().trim().max(max);
export const reqStr = (max = 500, min = 1) => z.string().trim().min(min, 'Required').max(max);
export const password = z.string().min(8, 'Password must be at least 8 characters').max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers');
export const email = z.string().trim().toLowerCase().email('Enter a valid email').max(254);
export const page = z.coerce.number().int().min(1).max(10000).default(1);
