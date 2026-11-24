-- Clean slate: removes every user and every course, keeps the platform super admin(s) and the "yapha" organisation.
--
-- KEEPS    super admin account(s) (role 'superadmin'), the organisation 'yapha' with its name, branding (logo), colours and
--          settings, all rows of audit_logs that are not tied to a removed user, the opt-out list (mail_suppressions),
--          and every file in the uploads bucket (this script never touches the bucket).
-- REMOVES  all other users and everything they own (enrolments, progress, quiz attempts, certificates, payments, notifications,
--          sign-in tokens, recovery codes, teacher applications), all courses (versions, reviews), the organisations other than
--          'yapha', the saved Paystack keys (payment_accounts: re-enter them in the new encryption key), queued emails,
--          recipient history, rate-limit counters, and the database rows of uploaded files (logo and the super admin's photo kept).
--          Audit rows are removed when the actor is a removed user, the target is a removed user, or they belong to a removed organisation.
--          Member numbers of 'yapha' restart from 1.
--
-- Safe by default: it is a DRY RUN that prints before/after counts and rolls back. To keep the changes, add -v commit_it=true.
--   psql "$DATABASE_URL_UNPOOLED" -X -f deploy/maintenance/clean-slate.sql                    # dry run
--   psql "$DATABASE_URL_UNPOOLED" -X -f deploy/maintenance/clean-slate.sql -v commit_it=true  # for real
-- Take a backup first (gcloud run jobs execute yapha-backup ...) and a Neon branch. Use a direct (unpooled) connection, as the
-- database owner, with PGSSLROOTCERT=system for Neon. Stop traffic or accept that sign-ins during the run wait for the transaction.
\set ON_ERROR_STOP on
\if :{?commit_it}
\else
  \set commit_it false
\endif

BEGIN;
SET LOCAL app.bypass = 'on';                      -- row-level security: act as the platform
SET LOCAL lock_timeout = '15s';

-- The account protections that exist to stop accidents are switched off for this transaction only.
ALTER TABLE users      DISABLE TRIGGER users_protect;
ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_change;

CREATE TEMP TABLE doomed_users   ON COMMIT DROP AS SELECT id FROM users   WHERE role <> 'superadmin';
CREATE TEMP TABLE doomed_tenants ON COMMIT DROP AS SELECT id FROM tenants WHERE slug <> 'yapha';
CREATE TEMP TABLE kept_files     ON COMMIT DROP AS
  SELECT (settings -> 'branding' ->> 'logoFileId')::uuid AS id FROM tenants WHERE slug = 'yapha' AND settings -> 'branding' ->> 'logoFileId' IS NOT NULL
  UNION
  SELECT photo_file_id FROM users WHERE role = 'superadmin' AND photo_file_id IS NOT NULL;

CREATE TEMP TABLE counts_before ON COMMIT DROP AS
  SELECT 'users' AS t, count(*) AS n FROM users UNION ALL SELECT 'courses', count(*) FROM courses
  UNION ALL SELECT 'enrollments', count(*) FROM enrollments UNION ALL SELECT 'payments', count(*) FROM payments
  UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs UNION ALL SELECT 'files', count(*) FROM files
  UNION ALL SELECT 'tenants', count(*) FROM tenants UNION ALL SELECT 'superadmins', count(*) FROM users WHERE role = 'superadmin';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'superadmin') THEN RAISE EXCEPTION 'no super admin found: refusing to run'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE slug = 'yapha') THEN RAISE EXCEPTION 'organisation yapha not found: refusing to run'; END IF;
END $$;

-- Learning records, then payments (enrolments point at payments), then everything that points at courses.
DELETE FROM lesson_progress;
DELETE FROM quiz_states;
DELETE FROM quiz_attempts;
DELETE FROM certificates;
DELETE FROM enrollments;
DELETE FROM payments;
DELETE FROM payment_accounts;                      -- saved Paystack keys: re-enter them with the new DATA_ENCRYPTION_KEY
DELETE FROM course_reviews;
DELETE FROM courses;                               -- course_versions go with them (ON DELETE CASCADE)

DELETE FROM notifications     WHERE user_id IN (SELECT id FROM doomed_users);
DELETE FROM user_tokens       WHERE user_id IN (SELECT id FROM doomed_users);
DELETE FROM recovery_codes    WHERE user_id IN (SELECT id FROM doomed_users);
DELETE FROM teacher_applications;
DELETE FROM email_outbox;
DELETE FROM mail_recipients;
DELETE FROM rate_limits;
-- mail_suppressions (people who asked to stop receiving emails) is deliberately kept.

-- Audit rows tied to the removed users or organisations (the table is append-only; its trigger is off for this transaction).
DELETE FROM audit_logs
 WHERE actor_id  IN (SELECT id FROM doomed_users)
    OR tenant_id IN (SELECT id FROM doomed_tenants)
    OR (target_type = 'user' AND target_id IN (SELECT id::text FROM doomed_users));

-- Uploaded files: database rows go (the objects in the bucket stay), except the logo and the super admin's photo.
UPDATE users SET photo_file_id = NULL WHERE id IN (SELECT id FROM doomed_users);
UPDATE files SET owner_id = NULL WHERE id IN (SELECT id FROM kept_files);
DELETE FROM files WHERE id NOT IN (SELECT id FROM kept_files);

DELETE FROM users WHERE id IN (SELECT id FROM doomed_users);
DELETE FROM tenants WHERE id IN (SELECT id FROM doomed_tenants);
UPDATE tenants SET member_seq = 0 WHERE slug = 'yapha';

ALTER TABLE users      ENABLE TRIGGER users_protect;
ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_change;

-- Safety checks: abort (and roll back) if anything other than the super admin(s) is left, or a super admin went missing.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role <> 'superadmin') THEN RAISE EXCEPTION 'users other than the super admin remain'; END IF;
  IF (SELECT count(*) FROM users) <> (SELECT n FROM counts_before WHERE t = 'superadmins') THEN RAISE EXCEPTION 'a super admin row was lost'; END IF;
  IF (SELECT count(*) FROM tenants) <> 1 THEN RAISE EXCEPTION 'expected exactly one organisation (yapha) to remain'; END IF;
  IF EXISTS (SELECT 1 FROM tenants WHERE slug = 'yapha' AND settings -> 'branding' ->> 'logoFileId' IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id = (settings -> 'branding' ->> 'logoFileId')::uuid)) THEN RAISE EXCEPTION 'the yapha logo file row is gone'; END IF;
END $$;

\echo
\echo '--- before -> after'
SELECT b.t AS "table", b.n AS before,
       CASE b.t WHEN 'users' THEN (SELECT count(*) FROM users) WHEN 'courses' THEN (SELECT count(*) FROM courses)
                WHEN 'enrollments' THEN (SELECT count(*) FROM enrollments) WHEN 'payments' THEN (SELECT count(*) FROM payments)
                WHEN 'audit_logs' THEN (SELECT count(*) FROM audit_logs) WHEN 'files' THEN (SELECT count(*) FROM files)
                WHEN 'tenants' THEN (SELECT count(*) FROM tenants) WHEN 'superadmins' THEN (SELECT count(*) FROM users WHERE role = 'superadmin') END AS after
  FROM counts_before b ORDER BY b.t;
\echo '--- what remains'
SELECT email, role, tenant_id IS NULL AS platform_level, totp_enabled FROM users;
SELECT slug, name, status, member_seq, settings -> 'branding' ->> 'logoFileId' AS logo_file FROM tenants;

\if :commit_it
  \echo 'COMMIT'
  COMMIT;
\else
  \echo 'DRY RUN: rolled back. Nothing changed. Add -v commit_it=true to keep these changes.'
  ROLLBACK;
\endif
