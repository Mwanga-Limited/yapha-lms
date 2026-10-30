import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { pool } from './db.js';
import { platformApi, tenantApi } from './routes/index.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
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
        'connect-src': ["'self'", 'https://accounts.google.com/gsi/'],
        'upgrade-insecure-requests': config.cookieSecure ? [] : null,
      },
    },
  }));
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  // CSRF defence in depth: JSON-only POSTs (plus SameSite=strict cookies).
  app.use('/api', (req, _res, next) => {
    if (req.method === 'POST' && !req.path.endsWith('/upload') && !req.is('application/json')) throw new HttpError(415, 'Send JSON');
    next();
  });

  // Health check for load balancers and monitoring: the API is up and the database answers.
  app.get('/api/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false, error: 'Database unavailable' }); }
  });

  // ---- the API: the same 8 endpoints for every organisation under /api/t/<organisation>/..., plus the platform console
  app.use('/api/t/:tenant', tenantApi());   // auth, account, courses, learn, admin, upload, files/:id, certificates/:code
  app.use('/api/platform', platformApi());  // super admin: sign-in, organisations, cross-organisation views

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built frontend (single deployment) when it exists.
  if (fs.existsSync(path.join(config.frontendDist, 'index.html'))) {
    app.use(express.static(config.frontendDist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(config.frontendDist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return res.status(400).json({ error: i ? `${i.path.join('.') || 'input'}: ${i.message}` : 'Invalid input', issues: err.issues.map((x) => ({ path: x.path, message: x.message })) });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
    if (err?.code === '23505') return res.status(409).json({ error: 'This already exists' });
    if (err?.code === '23503') { if (!config.isProd) console.error('[fk]', err.detail, err.constraint); return res.status(409).json({ error: 'This record is still in use' }); }
    if (err?.code === 'P0001') return res.status(403).json({ error: err.message });
    if (err?.code === '42501') return res.status(403).json({ error: 'You do not have access to this organisation\'s data' });  // row-level security
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}
