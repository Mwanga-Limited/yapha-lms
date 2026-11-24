import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { db, query, withScope } from '../db.js';
import { SUPPRESSIBLE_KINDS, emailHash, isSuppressed } from './mailguard.js';
import { logger } from './logger.js';

/** Emails sent while MAIL_TRANSPORT=memory (used by the tests). */
export const memoryInbox = [];

let transporter = null;
if (config.mail.transport === 'smtp') {
  transporter = nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
}

const BACKOFF_MINUTES = [1, 5, 30, 120, 720];   // after attempt 1, 2, 3, 4, 5; a sixth failure is final
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const LEASE_SECONDS = 120;

/** Write an email to the outbox, inside the current request's transaction. Returns the row id. */
export async function enqueue(db, { kind, message, notAfterMinutes = null }) {
  const { rows: [row] } = await db.query(
    `INSERT INTO email_outbox (kind, to_email, to_hash, message, not_after)
     VALUES ($1,$2,$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(mins => $5::int) END) RETURNING id`,
    [kind, message.to, emailHash(message.to), JSON.stringify(message), notAfterMinutes]);
  return row.id;
}

let transmitOverride = null;
export function setTransmitForTests(fn) {
  if (!config.isTest) throw new Error('only for tests');
  transmitOverride = fn;
}

async function transmit(message) {
  if (transmitOverride) return transmitOverride(message);
  if (config.mail.transport === 'smtp') await transporter.sendMail(message);
  else if (config.mail.transport === 'memory') memoryInbox.push(message);
  else console.log(`\n[mail] To: ${message.to}\n[mail] Subject: ${message.subject}\n${message.text}\n`);
}

const isPermanent = (err) => typeof err?.responseCode === 'number' && err.responseCode >= 500 && err.responseCode < 600;

/** Claim due rows (a lease, so two workers never send the same email), optionally only the given ids. */
async function claim(limit, ids = null) {
  return withScope({ bypass: true }, async () => {
    await query(`UPDATE email_outbox SET status = 'expired' WHERE status = 'pending' AND not_after IS NOT NULL AND not_after < now()`);
    const { rows } = await query(
      `UPDATE email_outbox SET locked_until = now() + make_interval(secs => $1), attempts = attempts + 1
        WHERE id IN (SELECT id FROM email_outbox
                      WHERE status = 'pending' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
                        AND ($3::uuid[] IS NULL OR id = ANY($3))
                      ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, to_hash, message, attempts`, [LEASE_SECONDS, limit, ids]);
    return rows;
  });
}

async function settle(row, outcome) {
  await withScope({ bypass: true }, async () => {
    if (outcome.sent) {
      // Sign-in codes are secrets: drop the body once delivered. Everything else is kept for a week for support.
      await query(`UPDATE email_outbox SET status = 'sent', sent_at = now(), locked_until = NULL, last_error = NULL,
                          message = CASE WHEN kind = 'mfa' THEN jsonb_build_object('to', message->>'to', 'subject', 'sign-in code') ELSE message END WHERE id = $1`, [row.id]);
    } else if (outcome.suppressed) {
      await query(`UPDATE email_outbox SET status = 'suppressed', locked_until = NULL, last_error = 'recipient opted out' WHERE id = $1`, [row.id]);
    } else {
      const final = outcome.permanent || row.attempts >= MAX_ATTEMPTS;
      const wait = BACKOFF_MINUTES[Math.min(row.attempts, BACKOFF_MINUTES.length) - 1];
      await query(`UPDATE email_outbox SET status = $2, locked_until = NULL, last_error = $3, next_attempt_at = now() + make_interval(mins => $4) WHERE id = $1`,
        [row.id, final ? 'failed' : 'pending', String(outcome.error).slice(0, 300), wait]);
      logger.error(final ? 'mail failed permanently' : 'mail send failed, will retry', { outboxId: row.id, kind: row.kind, attempt: row.attempts, err: outcome.err });
    }
  });
}

/** Deliver claimed rows. Never throws. */
async function deliver(rows) {
  for (const row of rows) {
    try {
      if (SUPPRESSIBLE_KINDS.has(row.kind)) {
        const suppressed = await withScope({ bypass: true }, () => isSuppressed(db, row.to_hash));
        if (suppressed) { await settle(row, { suppressed: true }); continue; }
      }
      await transmit(row.message);
      await settle(row, { sent: true });
    } catch (err) {
      await settle(row, { error: err.message, err, permanent: isPermanent(err) }).catch((e) => logger.error('outbox settle failed', { err: e }));
    }
  }
}

/** Try to send these specific emails now (called right after the request commits). */
export async function deliverNow(ids) {
  try { await deliver(await claim(ids.length, ids)); } catch (err) { logger.error('outbox immediate delivery failed', { err }); }
}

/** Worker pass (Cloud Scheduler calls this every minute): send due and retried emails, report the queue. */
export async function drainOutbox({ batch = 25 } = {}) {
  const rows = await claim(batch);
  await deliver(rows);
  const stats = await withScope({ bypass: true }, async () => {
    await query(`DELETE FROM email_outbox WHERE status IN ('sent', 'suppressed', 'expired') AND created_at < now() - interval '7 days'`);
    const { rows: [s] } = await query(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed_24h,
              coalesce(extract(epoch FROM now() - min(next_attempt_at) FILTER (WHERE status = 'pending' AND next_attempt_at < now())), 0)::int AS oldest_due_sec
         FROM email_outbox`);
    return s;
  });
  logger.info('outbox', { processed: rows.length, pending: stats.pending, failed24h: stats.failed_24h, oldestDueSec: stats.oldest_due_sec });
  return { processed: rows.length, ...stats };
}
