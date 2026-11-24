import crypto from 'node:crypto';
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

const jwtSecret = required('JWT_SECRET', 'dev-only-insecure-secret-change-me');
if (isProd && (jwtSecret.length < 32 || /change-me|dev-only/i.test(jwtSecret))) {
  throw new Error('JWT_SECRET must be a random string of at least 32 characters in production (e.g. `openssl rand -base64 48`)');
}
const mailTransport = env.MAIL_TRANSPORT || (env.SMTP_HOST ? 'smtp' : 'console');
if (isProd && mailTransport !== 'smtp') {
  throw new Error('MAIL_TRANSPORT must be smtp in production: the console transport prints sign-in codes and reset links to the logs');
}

/** TOTP_ENCRYPTION_KEY: 32 random bytes, base64. Encrypts authenticator-app secrets in the database. */
function parseKey(name, raw) {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 random bytes, base64-encoded (e.g. \`openssl rand -base64 32\`)`);
  return key;
}
const totpKey = parseKey('TOTP_ENCRYPTION_KEY', env.TOTP_ENCRYPTION_KEY)
  ?? (isProd ? (() => { throw new Error('Missing required environment variable TOTP_ENCRYPTION_KEY (openssl rand -base64 32)'); })()
    : Buffer.from(crypto.hkdfSync('sha256', jwtSecret, '', 'totp-dev-key', 32)));   // development and tests only
const storageDriver = env.STORAGE_DRIVER || 'disk';   // disk | gcs
if (!['disk', 'gcs'].includes(storageDriver)) throw new Error('STORAGE_DRIVER must be disk or gcs');
if (storageDriver === 'gcs' && !env.GCS_BUCKET) throw new Error('GCS_BUCKET is required when STORAGE_DRIVER=gcs');

const databaseUrl = required('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/yapha_lms');

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT || 4000),
  databaseUrl,
  // Direct (unpooled) connection for work a connection pooler breaks: migrations (advisory lock), pg_dump, restores.
  // Falls back to DATABASE_URL. Never used by tests, so a developer's .env cannot point them at a real database.
  databaseUrlUnpooled: env.NODE_ENV === 'test' ? databaseUrl : env.DATABASE_URL_UNPOOLED || databaseUrl,
  appDbUser: env.APP_DB_USER || '',               // restricted runtime role (see README)
  jwtSecret,
  totpKey,
  totpKeyPrevious: parseKey('TOTP_ENCRYPTION_KEY_PREVIOUS', env.TOTP_ENCRYPTION_KEY_PREVIOUS),   // only while rotating the key
  dbPoolMax: Number(env.DB_POOL_MAX || 10),                // per instance: instances x this must stay under the database's connection limit
  storage: { driver: storageDriver, gcsBucket: env.GCS_BUCKET || '' },
  rateLimitStore: env.RATE_LIMIT_STORE || (isProd ? 'postgres' : 'memory'),   // postgres = shared by every instance
  // Calls from Cloud Scheduler (outbox drain, clean-up): a Google-signed OIDC token for this audience from this service account.
  internal: { audience: env.INTERNAL_AUDIENCE || '', invokerEmail: env.INTERNAL_INVOKER_EMAIL || '' },
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
  uploadsPerHour: Number(env.UPLOADS_PER_HOUR || 60),     // uploads per signed-in user per hour
  orgStorageMb: Number(env.ORG_STORAGE_MB || 5120),       // total uploaded files per organisation
  invitesPerDay: Number(env.INVITES_PER_DAY || 50),       // invitations an organisation may send per 24 h
  newOrgInvitesPerDay: Number(env.NEW_ORG_INVITES_PER_DAY || 5), // same, during an organisation's first 24 h
  metricsToken: env.METRICS_TOKEN || '',                  // enables GET /api/metrics (Bearer token); off when empty
  logLevel: env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info'),
  betterstack: { token: env.BETTERSTACK_SOURCE_TOKEN || '', host: env.BETTERSTACK_INGESTING_HOST || '', errorsDsn: env.BETTERSTACK_ERRORS_DSN || '' },   // ships logs to Better Stack when both are set
  mail: {
    transport: mailTransport, // smtp | console | memory
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || 'Yapha <no-reply@yapha.local>',
  },
};
