-- The organisation that held all pre-multitenancy data becomes "Yapha" at /t/yapha.
-- Runs only if it is still called "default" (safe on fresh and already-renamed databases).
DO $$
DECLARE t uuid := (SELECT id FROM tenants WHERE slug = 'default');
BEGIN
  IF t IS NULL OR EXISTS (SELECT 1 FROM tenants WHERE slug = 'yapha') THEN RETURN; END IF;

  UPDATE tenants SET slug = 'yapha',
                     name = CASE WHEN name = 'Default organisation' THEN 'Yapha' ELSE name END,
                     updated_at = now()
   WHERE id = t;

  -- Member IDs follow the organisation's web address (DEFAULT-000001 -> YAPHA-000001).
  -- Member IDs are normally permanent; this one-off rename suspends that guard for this statement only.
  ALTER TABLE users DISABLE TRIGGER users_protect;
  UPDATE users SET member_code = regexp_replace(member_code, '^DEFAULT-', 'YAPHA-')
   WHERE tenant_id = t AND member_code LIKE 'DEFAULT-%';
  ALTER TABLE users ENABLE TRIGGER users_protect;

  UPDATE certificates SET member_code = regexp_replace(member_code, '^DEFAULT-', 'YAPHA-'),
                          issuer_name = CASE WHEN issuer_name = 'Default organisation' THEN 'Yapha' ELSE issuer_name END
   WHERE tenant_id = t;
END $$;
