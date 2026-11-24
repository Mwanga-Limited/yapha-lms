import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { ZodError } from 'zod';
import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { captureError } from './lib/error-tracking.js';
import { storage } from './lib/storage.js';
import { observeRequest, renderMetrics } from './lib/metrics.js';
import { pool } from './db.js';
import { pendingMigrations } from './scripts/migrate.js';
import { organisationsApi, platformApi, tenantApi } from './routes/index.js';
import { internalApi } from './routes/internal.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Request ID (also returned to the client so support can quote it), access log and metrics.
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      observeRequest(res.statusCode, seconds);
      if (req.path === '/api/health' || req.path === '/api/metrics') return;
      logger.info('request', {
        requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0].replace(/\/certificates\/[^/]+/, '/certificates/:code'),
        status: res.statusCode, ms: Math.round(seconds * 1000), tenant: req.tenant?.slug, userId: req.user?.id, ip: req.ip,
      });
    });
    next();
  });
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://accounts.google.com/gsi/client'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style', 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'blob:', 'https:'],
        'frame-src': ["'self'", 'https://accounts.google.com', 'https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com'],
        'connect-src': ["'self'", 'https://accounts.google.com/gsi/',
          ...(config.storage.driver === 'gcs' ? ['https://storage.googleapis.com'] : []),   // the browser PUTs uploads straight to the bucket (signed address)
          ...(config.betterstack.host ? [`https://${config.betterstack.host}`] : [])],   // the browser reports errors to Better Stack
        'upgrade-insecure-requests': config.cookieSecure ? [] : null,
      },
    },
  }));
  // rawBody: Paystack webhooks are checked against a signature of the exact bytes received.
  app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { if (req.originalUrl.endsWith('/payments/webhook')) req.rawBody = buf; } }));
  app.use(cookieParser());

  // CSRF defence in depth: JSON-only POSTs (plus SameSite=strict cookies).
  app.use('/api', (req, _res, next) => {
    if (req.method === 'POST' && !req.path.endsWith('/upload') && !req.path.startsWith('/internal/') && !req.is('application/json')) throw new HttpError(415, 'Send JSON');
    next();
  });

  // Health check for load balancers and monitoring: database answers, migrations are applied, file storage is reachable.
  app.get('/api/health', async (_req, res) => {
    const checks = { database: false, migrations: false, storage: false };
    try { await pool.query('SELECT 1'); checks.database = true; } catch { /* reported below */ }
    if (checks.database) { try { checks.migrations = (await pendingMigrations()).length === 0; } catch { /* reported below */ } }
    checks.storage = await storage.healthy();
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503).json({ ok, checks });
  });

  // Prometheus-style metrics. Disabled unless METRICS_TOKEN is set; then requires "Authorization: Bearer <token>".
  app.get('/api/metrics', (req, res) => {
    if (!config.metricsToken) return res.status(404).json({ error: 'Not found' });
    const given = Buffer.from(req.get('authorization') ?? '');
    const want = Buffer.from(`Bearer ${config.metricsToken}`);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'Unauthorized' });
    res.type('text/plain; version=0.0.4').send(renderMetrics());
  });

  // ---- the API: the platform's own routes first, then the same endpoints for every organisation under /api/<organisation>/...
  // "platform", "organisations" and "health" are reserved words (RESERVED_SLUGS), so no organisation can take them.
  app.use('/api/internal', express.json({ limit: '10kb' }), internalApi());   // Cloud Scheduler only (OIDC); "internal" is a reserved word
  app.use('/api/platform', platformApi());  // super admin: sign-in, organisations, cross-organisation views
  app.use('/api/organisations', organisationsApi());  // public: an organisation registers itself
  app.use('/api/:tenant', tenantApi());     // auth, account, courses, learn, admin, payments, upload, files/:id, certificates/:code

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built frontend (single deployment) when it exists.
  if (fs.existsSync(path.join(config.frontendDist, 'index.html'))) {
    app.use(express.static(config.frontendDist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(config.frontendDist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const send = (status, body) => res.status(status).json({ ...body, requestId: req.id });
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return send(400, { error: i ? `${i.path.join('.') || 'input'}: ${i.message}` : 'Invalid input', issues: err.issues.map((x) => ({ path: x.path, message: x.message })) });
    }
    if (err instanceof HttpError) return send(err.status, { error: err.message, ...err.extra });
    if (err instanceof multer.MulterError) return send(400, { error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : err.message });
    if (err?.type === 'entity.parse.failed') return send(400, { error: 'Invalid JSON' });
    if (err?.type === 'entity.too.large') return send(413, { error: 'Request is too large' });
    if (err?.code === '23505') return send(409, { error: 'This already exists' });
    if (err?.code === '23503') { logger.warn('foreign key refused', { requestId: req.id, detail: err.detail, constraint: err.constraint }); return send(409, { error: 'This record is still in use' }); }
    if (err?.code === 'P0001') return send(403, { error: err.message });
    if (err?.code === '42501') return send(403, { error: 'You do not have access to this organisation\'s data' });  // row-level security
    logger.error('unhandled error', { requestId: req.id, method: req.method, path: req.path, err });
    captureError(err, { requestId: req.id, method: req.method, path: req.path, tenant: req.tenant?.slug });
    send(500, { error: 'Something went wrong. Please try again.' });
  });
  return app;
}
