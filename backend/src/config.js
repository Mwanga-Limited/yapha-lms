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
  orgSignupOpen: (env.ORG_SIGNUP || 'open') !== 'closed',   // organisations register themselves at /register
  orgSignupPerHour: Number(env.ORG_SIGNUP_PER_HOUR || (isProd ? 5 : 100)),   // registrations per IP per hour
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  // Encrypts secrets kept in the database (organisations' Paystack secret keys). Keep it safe and never change it:
  // changing it means every organisation has to enter its Paystack keys again.
  dataEncryptionKey: required('DATA_ENCRYPTION_KEY', 'dev-only-data-encryption-key-change-me'),
  paystackApiUrl: (env.PAYSTACK_API_URL || 'https://api.paystack.co').replace(/\/$/, ''),
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
    from: env.MAIL_FROM || 'Yapha <no-reply@yapha.local>',
  },
};
