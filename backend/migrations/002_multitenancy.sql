-- Multitenancy: every organisation (tenant) gets its own isolated block of data.
-- Isolation is enforced by PostgreSQL row-level security (RLS), not only by application code:
-- each request runs as the restricted role "elearning_app" with app.tenant_id set, and every
-- tenant table only returns / accepts rows for that tenant. Only the platform super admin
-- (app.bypass = 'on') can see across tenants.

-- (Part 1 of 2. The new 'superadmin' role value must be committed before 003 can use it.)

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_bypass() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.bypass', true), '') = 'on' $$;

-- ---------------------------------------------------------------- tenants
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name        text        NOT NULL CHECK (length(btrim(name)) > 0),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  settings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  member_seq  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Existing data (from before multitenancy) moves into a "default" organisation.
INSERT INTO tenants (slug, name) VALUES ('default', 'Default organisation');

-- ---------------------------------------------------------------- super admin role
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'superadmin';
