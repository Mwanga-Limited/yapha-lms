-- Referrals: every member has a referral code (and link); new members may be referred by one.
-- Course web addresses: every course has a readable slug made from its title, e.g. /yapha/courses/bookkeeping-basics.

-- ---------------------------------------------------------------- referrals
ALTER TABLE users
  ADD COLUMN referral_code text,
  ADD COLUMN referred_by   uuid REFERENCES users(id);
CREATE UNIQUE INDEX users_referral_code_key ON users (tenant_id, referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX users_referred_by_idx ON users (referred_by) WHERE referred_by IS NOT NULL;

-- 8 characters without look-alikes (no 0/O, 1/I/L), unique inside the organisation. Super admins get none.
CREATE FUNCTION assign_referral_code() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; code text;
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.referral_code IS NOT NULL THEN RETURN NEW; END IF;
  LOOP
    code := '';
    FOR i IN 1..8 LOOP code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE tenant_id = NEW.tenant_id AND referral_code = code);
  END LOOP;
  NEW.referral_code := code;
  RETURN NEW;
END $$;
CREATE TRIGGER users_referral_code BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION assign_referral_code();

-- Existing members get a code too (the trigger runs on insert only, so give them one here).
DO $$
DECLARE r record; alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; code text;
BEGIN
  FOR r IN SELECT id, tenant_id FROM users WHERE tenant_id IS NOT NULL AND referral_code IS NULL LOOP
    LOOP
      code := '';
      FOR i IN 1..8 LOOP code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE tenant_id = r.tenant_id AND referral_code = code);
    END LOOP;
    UPDATE users SET referral_code = code WHERE id = r.id;
  END LOOP;
END $$;

-- A referral stays inside the organisation, and nobody refers themselves.
CREATE FUNCTION check_referral() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.referral_code IS NOT NULL AND NEW.referral_code IS DISTINCT FROM OLD.referral_code THEN
    RAISE EXCEPTION 'Referral codes cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.referred_by IS NOT NULL AND NEW.referred_by IS DISTINCT FROM OLD.referred_by THEN
    RAISE EXCEPTION 'A referral cannot be changed once recorded' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.referred_by IS NULL THEN RETURN NEW; END IF;
  IF NEW.referred_by = NEW.id THEN RAISE EXCEPTION 'You cannot refer yourself' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.referred_by AND tenant_id IS NOT DISTINCT FROM NEW.tenant_id) THEN
    RAISE EXCEPTION 'The referrer belongs to another organisation' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_check_referral BEFORE INSERT OR UPDATE OF referred_by, referral_code ON users FOR EACH ROW EXECUTE FUNCTION check_referral();

-- ---------------------------------------------------------------- course slugs
-- Made from the title: lower case, letters and numbers joined by hyphens, at most 80 characters;
-- "-2", "-3"… is added if another course in the organisation already uses it.
-- The slug follows the title until the course is first published; after that it never changes, so shared links keep working.
CREATE FUNCTION slugify(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(nullif(left(trim(both '-' FROM regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', '-', 'g')), 80), ''), 'course')
$$;

ALTER TABLE courses ADD COLUMN slug text;

CREATE FUNCTION assign_course_slug() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE base text; candidate text; n integer := 1;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.title IS NOT DISTINCT FROM OLD.title OR OLD.published_at IS NOT NULL) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := trim(both '-' FROM left(slugify(NEW.title), 72));
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM courses WHERE tenant_id = NEW.tenant_id AND slug = candidate AND id <> NEW.id) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END $$;

-- Existing courses (oldest first, so the first course keeps the plain slug).
DO $$
DECLARE r record; base text; candidate text; n integer;
BEGIN
  FOR r IN SELECT id, tenant_id, title FROM courses ORDER BY created_at, id LOOP
    base := trim(both '-' FROM left(slugify(r.title), 72));
    candidate := base; n := 1;
    WHILE EXISTS (SELECT 1 FROM courses WHERE tenant_id = r.tenant_id AND slug = candidate) LOOP
      n := n + 1; candidate := base || '-' || n;
    END LOOP;
    UPDATE courses SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

CREATE TRIGGER courses_slug BEFORE INSERT OR UPDATE OF title ON courses FOR EACH ROW EXECUTE FUNCTION assign_course_slug();
ALTER TABLE courses ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX courses_tenant_slug_key ON courses (tenant_id, slug);
