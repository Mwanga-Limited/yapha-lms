import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name, devDefault) {
  const v = env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return devDefault;
}

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT || 4000),
  databaseUrl: required('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/elearning'),
  appDbUser: env.APP_DB_USER || '',               // restricted runtime role (see README)
  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
  sessionHours: Number(env.SESSION_HOURS || 12),
  appUrl: (env.APP_URL || 'http://localhost:5173').replace(/\/$/, ''),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  trustProxy: env.TRUST_PROXY || (isProd ? '1' : 'loopback'),
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  uploadDir: path.resolve(env.UPLOAD_DIR || 'uploads'),
  frontendDist: path.resolve(env.FRONTEND_DIST || '../frontend/dist'),
  bcryptRounds: Number(env.BCRYPT_ROUNDS || 12),
  rateLimitMax: Number(env.AUTH_RATE_LIMIT_MAX || 100),   // requests to /api/auth per IP per 15 min
  loginMaxFailures: Number(env.LOGIN_MAX_FAILURES || 5),  // per email per 15 min
  mail: {
    transport: env.MAIL_TRANSPORT || (env.SMTP_HOST ? 'smtp' : 'console'), // smtp | console | memory
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || 'E-Learning <no-reply@elearning.local>',
  },
};
