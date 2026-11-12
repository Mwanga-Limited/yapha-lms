-- Referral codes are now used when enrolling in a course, not when signing up.
--   * Every member's referral code is unique across the whole platform.
--   * A payment, and the enrolment it creates, records whose referral code was used.
--   * Sign-up referrals (users.referred_by, from migration 009) are removed.

-- ---------------------------------------------------------------- no more sign-up referrals
DROP TRIGGER IF EXISTS users_check_referral ON users;
DROP FUNCTION IF EXISTS check_referral();
ALTER TABLE users DROP COLUMN IF EXISTS referred_by;

-- ---------------------------------------------------------------- codes unique across the platform
-- Codes were unique per organisation; give a new code to any that repeat in another organisation (the oldest keeps it).
DO $$
DECLARE r record; alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; code text;
BEGIN
  FOR r IN
    SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY referral_code ORDER BY created_at, id) AS n
                      FROM users WHERE referral_code IS NOT NULL) d WHERE n > 1
  LOOP
    LOOP
      code := '';
      FOR i IN 1..8 LOOP code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE referral_code = code);
    END LOOP;
    UPDATE users SET referral_code = code WHERE id = r.id;
  END LOOP;
END $$;
DROP INDEX IF EXISTS users_referral_code_key;
CREATE UNIQUE INDEX users_referral_code_key ON users (referral_code) WHERE referral_code IS NOT NULL;

CREATE OR REPLACE FUNCTION assign_referral_code() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; code text;
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.referral_code IS NOT NULL THEN RETURN NEW; END IF;
  LOOP
    code := '';
    FOR i IN 1..8 LOOP code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE referral_code = code);
  END LOOP;
  NEW.referral_code := code;
  RETURN NEW;
END $$;

-- A member's code never changes.
CREATE FUNCTION protect_referral_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.referral_code IS NOT NULL AND NEW.referral_code IS DISTINCT FROM OLD.referral_code THEN
    RAISE EXCEPTION 'Referral codes cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_referral_code_fixed BEFORE UPDATE OF referral_code ON users FOR EACH ROW EXECUTE FUNCTION protect_referral_code();

-- ---------------------------------------------------------------- referrals on payments and enrolments
ALTER TABLE payments    ADD COLUMN referred_by uuid REFERENCES users(id);
ALTER TABLE enrollments ADD COLUMN referred_by uuid REFERENCES users(id);
CREATE INDEX payments_referred_by_idx    ON payments (referred_by)    WHERE referred_by IS NOT NULL;
CREATE INDEX enrollments_referred_by_idx ON enrollments (referred_by) WHERE referred_by IS NOT NULL;

-- The referrer is someone else in the same organisation, and a recorded referral never changes.
CREATE FUNCTION check_enrolment_referral() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.referred_by IS NOT NULL AND NEW.referred_by IS DISTINCT FROM OLD.referred_by THEN
    RAISE EXCEPTION 'A referral cannot be changed once recorded' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.referred_by IS NULL THEN RETURN NEW; END IF;
  IF NEW.referred_by = NEW.user_id THEN RAISE EXCEPTION 'You cannot use your own referral code' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.referred_by AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'The referrer belongs to another organisation' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_check_referral    BEFORE INSERT OR UPDATE OF referred_by ON payments    FOR EACH ROW EXECUTE FUNCTION check_enrolment_referral();
CREATE TRIGGER enrollments_check_referral BEFORE INSERT OR UPDATE OF referred_by ON enrollments FOR EACH ROW EXECUTE FUNCTION check_enrolment_referral();
