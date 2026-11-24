// Sends queued emails and retries failed ones, once a minute, until stopped. For installs WITHOUT Cloud Scheduler
// (docker compose, a single server, local development with MAIL_TRANSPORT=smtp). On Google Cloud, Cloud Scheduler calls
// POST /api/internal/outbox/drain instead and this script is not used.   Usage: npm run outbox:worker
import { pool } from '../db.js';
import { logger } from '../lib/logger.js';
import { drainOutbox } from '../lib/outbox.js';
import { purgeRateLimits } from '../lib/ratestore.js';

process.env.YAPHA_DB_BYPASS = 'on';
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; });

let tick = 0;
while (!stopping) {
  try {
    await drainOutbox();
    if (tick++ % 60 === 0) await purgeRateLimits();
  } catch (err) { logger.error('outbox worker pass failed', { err }); }
  for (let i = 0; i < 60 && !stopping; i++) await new Promise((r) => setTimeout(r, 1000));
}
await pool.end();
