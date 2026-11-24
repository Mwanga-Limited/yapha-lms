-- Idempotent: safe to re-run against a database where some of these objects already exist.
-- Cloud readiness: email outbox with retry, two-step sign-in hardening, cross-organisation invitation limits,
-- shared rate-limit counters, and two-phase file uploads (object storage).

-- ---------------------------------------------------------------- email outbox
-- Emails are written in the same transaction as the change that causes them, so a rolled-back request sends nothing and a
-- committed one can never lose its mail. A worker (and an immediate attempt after commit) delivers them, with retries.
CREATE TABLE IF NOT EXISTS email_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants(id) DEFAULT app_tenant(),
  kind            text        NOT NULL DEFAULT 'notice' CHECK (kind IN ('notice', 'invite', 'verify', 'reset', 'mfa')),
  to_email        text        NOT NULL,
  to_hash         text        NOT NULL,
  message         jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'suppressed', 'expired')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  not_after       timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS email_outbox_due_idx ON email_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS email_outbox_tenant_idx ON email_outbox (tenant_id);
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON email_outbox;
CREATE POLICY tenant_isolation ON email_outbox
  USING (app_bypass() OR tenant_id = app_tenant()) WITH CHECK (app_bypass() OR tenant_id = app_tenant());

-- ---------------------------------------------------------------- two-step sign-in
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;   -- the last accepted 30-second step: a code can never be used twice

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id) DEFAULT app_tenant(),
  user_id    uuid NOT NULL REFERENCES users(id),
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes (user_id);
CREATE INDEX IF NOT EXISTS recovery_codes_tenant_idx ON recovery_codes (tenant_id);
ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON recovery_codes;
CREATE POLICY tenant_isolation ON recovery_codes
  USING (app_bypass() OR tenant_id = app_tenant()) WITH CHECK (app_bypass() OR tenant_id = app_tenant());

-- ---------------------------------------------------------------- invitations across organisations
-- Deliberately NOT per organisation (no row-level security): the point is to see how often one address is mailed by anyone.
-- Addresses are stored only as keyed hashes.
CREATE TABLE IF NOT EXISTS mail_recipients (
  id         bigserial PRIMARY KEY,
  email_hash text        NOT NULL,
  kind       text        NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_recipients_idx ON mail_recipients (email_hash, kind, sent_at DESC);

-- People who asked not to receive invitations ("stop these emails").
CREATE TABLE IF NOT EXISTS mail_suppressions (
  email_hash text PRIMARY KEY,
  reason     text        NOT NULL DEFAULT 'recipient_request',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- rate-limit counters shared by every app instance
CREATE UNLOGGED TABLE IF NOT EXISTS rate_limits (
  key      text PRIMARY KEY,
  hits     integer     NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits (reset_at);

-- ---------------------------------------------------------------- two-phase uploads
-- 'pending' = a signed upload address was issued but the file has not been confirmed. Pending files are never served or linked.
ALTER TABLE files ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'ready'));
CREATE INDEX IF NOT EXISTS files_pending_idx ON files (created_at) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON email_outbox, recovery_codes, mail_recipients, mail_suppressions, rate_limits TO yapha_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yapha_app;
