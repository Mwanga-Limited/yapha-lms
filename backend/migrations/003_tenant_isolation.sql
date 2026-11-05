-- Tenant columns, member IDs, per-tenant uniqueness and row-level security.

-- ---------------------------------------------------------------- tenant_id on every tenant table
-- New rows take the tenant from the request scope (app.tenant_id), so inserts can't land in another tenant.
DO $$
DECLARE t text; def uuid := (SELECT id FROM tenants WHERE slug = 'default');
BEGIN
  FOREACH t IN ARRAY ARRAY['users','user_tokens','files','teacher_applications','courses','course_versions',
    'course_reviews','enrollments','lesson_progress','quiz_states','quiz_attempts','certificates','notifications','audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id uuid REFERENCES tenants(id)', t);
    -- One-off backfill of history into the default tenant. The audit log's append-only trigger is
    -- suspended only for this statement, inside this migration's transaction.
    IF t = 'audit_logs' THEN EXECUTE 'ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_change'; END IF;
    EXECUTE format('UPDATE %I SET tenant_id = %L', t, def);
    IF t = 'audit_logs' THEN EXECUTE 'ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_change'; END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT app_tenant()', t);
    EXECUTE format('CREATE INDEX %I ON %I (tenant_id)', t || '_tenant_idx', t);
  END LOOP;
END $$;

-- Existing history stays with the default tenant. From now on, platform-level rows (super admin
-- sign-ins and their sign-in codes, organisation creation) have tenant_id NULL, so users,
-- user_tokens and audit_logs allow NULL; all other tables always belong to an organisation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['files','teacher_applications','courses','course_versions',
    'course_reviews','enrollments','lesson_progress','quiz_states','quiz_attempts','certificates','notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- users: tenant members and platform super admins
-- Super admins belong to no tenant; everyone else belongs to exactly one.
ALTER TABLE users ADD CONSTRAINT users_tenant_role_ck CHECK ((tenant_id IS NULL) = (role = 'superadmin'));

-- The same email may register separately in different organisations.
DROP INDEX users_email_lower_key;
CREATE UNIQUE INDEX users_tenant_email_key ON users (tenant_id, lower(email)) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX users_platform_email_key ON users (lower(email)) WHERE tenant_id IS NULL;

-- One "first Admin" per tenant (AD-01 / AD-04 now apply inside each tenant).
DROP INDEX users_single_root;
CREATE UNIQUE INDEX users_single_root ON users (tenant_id) WHERE is_root;

-- Human-friendly member ID, unique inside the tenant, e.g. ACME-000042.
ALTER TABLE users ADD COLUMN member_code text;
CREATE UNIQUE INDEX users_member_code_key ON users (tenant_id, member_code) WHERE member_code IS NOT NULL;

CREATE FUNCTION assign_member_code() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer; prefix text;
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.member_code IS NOT NULL THEN RETURN NEW; END IF;
  UPDATE tenants SET member_seq = member_seq + 1 WHERE id = NEW.tenant_id
    RETURNING member_seq, upper(left(regexp_replace(slug, '[^a-z0-9]', '', 'g'), 8)) INTO n, prefix;
  NEW.member_code := prefix || '-' || lpad(n::text, 6, '0');
  RETURN NEW;
END $$;
CREATE TRIGGER users_member_code BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION assign_member_code();

-- Give existing users their member IDs, oldest first.
DO $$
DECLARE r record; n integer; prefix text;
BEGIN
  FOR r IN SELECT id, tenant_id FROM users WHERE tenant_id IS NOT NULL ORDER BY created_at LOOP
    UPDATE tenants SET member_seq = member_seq + 1 WHERE id = r.tenant_id
      RETURNING member_seq, upper(left(regexp_replace(slug, '[^a-z0-9]', '', 'g'), 8)) INTO n, prefix;
    UPDATE users SET member_code = prefix || '-' || lpad(n::text, 6, '0') WHERE id = r.id;
  END LOOP;
END $$;

-- Users can't move between tenants, and the super admin role can't be granted through the app.
CREATE OR REPLACE FUNCTION protect_users() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AD-05: accounts are deactivated, never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Accounts cannot move between organisations' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.is_root AND (NOT NEW.is_root OR NEW.role <> 'admin' OR NOT NEW.is_active) THEN
    RAISE EXCEPTION 'AD-04: the first Admin cannot be demoted or deactivated' USING ERRCODE = 'P0001';
  END IF;
  IF NOT OLD.is_root AND NEW.is_root THEN
    RAISE EXCEPTION 'AD-01: the first Admin can only be created when the organisation is created' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.member_code IS NOT NULL AND NEW.member_code IS DISTINCT FROM OLD.member_code THEN
    RAISE EXCEPTION 'Member IDs cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Certificates keep the organisation name as issued, and the learner's member ID.
ALTER TABLE certificates ADD COLUMN issuer_name text;
ALTER TABLE certificates ADD COLUMN member_code text;
UPDATE certificates c SET issuer_name = t.name, member_code = u.member_code
  FROM tenants t, users u WHERE t.id = c.tenant_id AND u.id = c.user_id;

ALTER TABLE files DROP CONSTRAINT files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check CHECK (purpose IN ('photo', 'thumbnail', 'lesson_file', 'lesson_video', 'logo'));

ALTER TABLE user_tokens DROP CONSTRAINT user_tokens_purpose_check;
ALTER TABLE user_tokens ADD CONSTRAINT user_tokens_purpose_check CHECK (purpose IN ('verify_email', 'reset_password', 'mfa_email', 'invite'));

-- ---------------------------------------------------------------- row-level security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','user_tokens','files','teacher_applications','courses','course_versions',
    'course_reviews','enrollments','lesson_progress','quiz_states','quiz_attempts','certificates','notifications','audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_bypass() OR tenant_id = app_tenant())
      WITH CHECK (app_bypass() OR tenant_id = app_tenant())$p$, t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (app_bypass() OR id = app_tenant()) WITH CHECK (app_bypass() OR id = app_tenant());

-- ---------------------------------------------------------------- restricted runtime role
-- Every request switches to this role (SET LOCAL ROLE), so RLS applies even when the app connects as
-- a superuser such as "postgres". It can never update/delete the audit log or delete users.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'elearning_app') THEN
    CREATE ROLE elearning_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
DO $$ BEGIN EXECUTE format('GRANT elearning_app TO %I', current_user); EXCEPTION WHEN OTHERS THEN NULL; END $$;

GRANT USAGE ON SCHEMA public TO elearning_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO elearning_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO elearning_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM elearning_app;
REVOKE DELETE, TRUNCATE ON users FROM elearning_app;
REVOKE DELETE, TRUNCATE ON tenants FROM elearning_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM elearning_app;
