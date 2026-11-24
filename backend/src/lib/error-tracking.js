import * as Sentry from '@sentry/node';
import { config } from '../config.js';

// Better Stack Errors (Sentry-compatible). Off unless BETTERSTACK_ERRORS_DSN is set, and never in tests.
const dsn = process.env.NODE_ENV === 'test' ? '' : config.betterstack.errorsDsn;
export const errorTrackingOn = Boolean(dsn);

const SECRET_KEY = /pass|token|secret|code|otp|totp|authorization|cookie|email|credential/i;
const scrub = (v, depth = 0) => {
  if (v == null || depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[redacted]' : scrub(x, depth + 1)]));
  return v;
};

if (dsn) {
  Sentry.init({
    dsn,
    environment: config.isProd ? 'production' : 'development',
    sendDefaultPii: false,
    defaultIntegrations: false,      // the app's own handlers (server.js, app.js) decide what is reported, once
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
    beforeSend(event) {
      delete event.request;           // no headers, cookies, bodies or query strings
      delete event.user;
      if (event.extra) event.extra = scrub(event.extra);
      return event;
    },
  });
}

/** Report an exception, tagged with the request id so it can be matched to the log lines. */
export function captureError(err, { requestId, ...extra } = {}) {
  if (!dsn) return;
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag('requestId', requestId);
    scope.setExtras(scrub(extra));
    Sentry.captureException(err);
  });
}

export const flushErrors = async () => { if (dsn) await Sentry.flush(2000).catch(() => {}); };
