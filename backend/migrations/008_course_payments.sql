-- Course payments with Paystack. Each organisation connects its own Paystack account;
-- one successful payment gives the learner full access to the course (no expiry).

-- ---------------------------------------------------------------- course prices (whole naira/cedi/… amounts are stored in the
-- smallest unit, e.g. kobo, as Paystack expects). 0 = free.
ALTER TABLE courses
  ADD COLUMN price_minor           integer NOT NULL DEFAULT 0 CHECK (price_minor >= 0),           -- set by the Admin
  ADD COLUMN suggested_price_minor integer NOT NULL DEFAULT 0 CHECK (suggested_price_minor >= 0); -- suggested by the teacher

-- ---------------------------------------------------------------- the organisation's Paystack keys
-- The secret key is stored encrypted (AES-256-GCM, key from DATA_ENCRYPTION_KEY) and never sent to the browser.
CREATE TABLE payment_accounts (
  tenant_id      uuid PRIMARY KEY DEFAULT app_tenant() REFERENCES tenants(id),
  provider       text NOT NULL DEFAULT 'paystack' CHECK (provider = 'paystack'),
  public_key     text NOT NULL,
  secret_key_enc text NOT NULL,
  secret_last4   text NOT NULL,
  live_mode      boolean NOT NULL,
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- payments
CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app_tenant() REFERENCES tenants(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  course_id    uuid NOT NULL REFERENCES courses(id),
  reference    text NOT NULL UNIQUE,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency     text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  live_mode    boolean NOT NULL,
  channel      text,                    -- card, bank, ussd… (from Paystack)
  paid_at      timestamptz,
  failure      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_tenant_idx ON payments (tenant_id);
CREATE INDEX payments_user_course_idx ON payments (user_id, course_id);
CREATE INDEX payments_created_idx ON payments (created_at DESC);
-- A learner pays for a course once.
CREATE UNIQUE INDEX payments_one_success ON payments (user_id, course_id) WHERE status = 'success';

ALTER TABLE enrollments ADD COLUMN payment_id uuid REFERENCES payments(id);

-- ---------------------------------------------------------------- tenant isolation, as for every other table
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_accounts', 'payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_bypass() OR tenant_id = app_tenant())
      WITH CHECK (app_bypass() OR tenant_id = app_tenant())$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_accounts TO elearning_app;
GRANT SELECT, INSERT, UPDATE ON payments TO elearning_app;   -- payments are never deleted
