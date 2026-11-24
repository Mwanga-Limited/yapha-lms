import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { drainOutbox } from '../lib/outbox.js';
import { purgeRateLimits } from '../lib/ratestore.js';
import { storage } from '../lib/storage.js';
import { withScope, query } from '../db.js';

/*
 * Endpoints for Cloud Scheduler only. Each call carries a Google-signed identity token (OIDC) for the scheduler's service
 * account; it is checked for signature, audience and the expected service-account email. Nothing else can reach these.
 */
let verifier = null;   // tests inject one
export function setInternalVerifierForTests(fn) {
  if (!config.isTest) throw new Error('only for tests');
  verifier = fn;
}
const google = new OAuth2Client();

async function requireScheduler(req, _res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
  if (!m) throw new HttpError(401, 'Unauthorized');
  try {
    const p = verifier ? await verifier(m[1]) : (await google.verifyIdToken({ idToken: m[1], audience: config.internal.audience })).getPayload();
    if (!config.internal.invokerEmail || p.email !== config.internal.invokerEmail || p.email_verified === false) throw new Error('wrong caller');
  } catch { throw new HttpError(401, 'Unauthorized'); }
  next();
}

export function internalApi() {
  const r = express.Router();
  r.use(requireScheduler);
  r.post('/outbox/drain', async (_req, res) => res.json(await drainOutbox()));

  /** Housekeeping: stale rate-limit rows, abandoned uploads, expired tokens. */
  r.post('/cleanup', async (_req, res) => {
    await purgeRateLimits();
    const stale = await withScope({ bypass: true }, async () => {
      const { rows } = await query(`DELETE FROM files WHERE status = 'pending' AND created_at < now() - interval '2 hours' RETURNING *`);
      return rows;
    });
    for (const f of stale) await storage.remove(f);
    const tokens = await withScope({ bypass: true }, async () => (await query(`DELETE FROM user_tokens WHERE expires_at < now() - interval '7 days'`)).rowCount);
    logger.info('cleanup', { abandonedUploads: stale.length, tokens });
    res.json({ abandonedUploads: stale.length, tokens });
  });
  return r;
}
