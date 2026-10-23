import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { loadUser } from './lib/security.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { certificatesRouter } from './routes/certificates.js';
import { courseRoutes } from './routes/courses.js';
import { filesRouter, uploadRouter } from './routes/files.js';
import { learnRoutes } from './routes/learn.js';

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
  app.use(loadUser);

  // CSRF defence in depth: JSON-only POSTs (plus SameSite=strict cookies).
  app.use('/api', (req, _res, next) => {
    if (req.method === 'POST' && !req.path.startsWith('/upload') && !req.is('application/json')) throw new HttpError(415, 'Send JSON');
    next();
  });

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.rateLimitMax, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a few minutes and try again.' } });

  // ---- the whole API: 8 endpoints
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.post('/api/auth', authLimiter, authRoutes);       // sign-up, sign-in, 2FA, Google, email verification, password reset
  app.post('/api/account', accountRoutes);              // profile, password, authenticator, notifications, teacher application, dashboard
  app.post('/api/courses', courseRoutes);               // catalogue, course detail, authoring & approval workflow, learners
  app.post('/api/learn', learnRoutes);                  // enrolment, player, lessons, progress, quizzes
  app.post('/api/admin', adminRoutes);                  // dashboard, reviews, applications, users, certificates, audit log
  app.use('/api/upload', uploadRouter);                 // POST multipart uploads
  app.use('/api/files', filesRouter);                   // GET files (signed URLs for private lesson files)
  app.use('/api/certificates', certificatesRouter);     // GET public verification + PDF

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
    if (err?.code === '23503') return res.status(409).json({ error: 'This record is still in use' });
    if (err?.code === 'P0001') return res.status(403).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}
