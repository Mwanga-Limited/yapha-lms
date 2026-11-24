import { Logtail } from '@logtail/node';
import { config } from '../config.js';
import { flushErrors } from './error-tracking.js';

// Optional Better Stack shipping (BETTERSTACK_SOURCE_TOKEN + BETTERSTACK_INGESTING_HOST). Never active in tests.
const bs = config.betterstack;
const logtail = bs.token && bs.host && process.env.NODE_ENV !== 'test'
  ? new Logtail(bs.token, { endpoint: `https://${bs.host}` })
  : null;

/** Send any buffered logs to Better Stack (call before the process exits). */
export const flushLogs = async () => { try { await Promise.all([logtail?.flush(), flushErrors()]); } catch { /* never block shutdown */ } };

/** Minimal structured logger: one JSON object per line on stdout/stderr, filtered by LOG_LEVEL. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const f = { ...fields };
  if (f.err instanceof Error) f.err = { name: f.err.name, message: f.err.message, code: f.err.code, stack: config.isProd ? undefined : f.err.stack };
  // Field names Google Cloud Logging understands: `severity` sets the log level and `message` the text shown in the console.
  const line = JSON.stringify({ time: new Date().toISOString(), severity: level.toUpperCase(), message: msg, ...f });
  if (logtail) {
    const { message, ...rest } = JSON.parse(line);
    logtail[level === 'debug' ? 'debug' : level](message, rest).catch(() => {});   // fire and forget: logging must never break a request
  }
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const logger = {
  debug: (msg, f) => write('debug', msg, f),
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
};
