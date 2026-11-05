-- E-Learning Platform — initial schema (PostgreSQL 13+)

CREATE TYPE user_role      AS ENUM ('student', 'teacher', 'admin');
CREATE TYPE course_status  AS ENUM ('draft', 'in_review', 'rejected', 'approved', 'published', 'unpublished', 'archived');
CREATE TYPE version_status AS ENUM ('draft', 'in_review', 'rejected', 'approved', 'superseded');

-- ---------------------------------------------------------------- files
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid,
  original_name text        NOT NULL,
  mime_type     text        NOT NULL,
  size_bytes    bigint      NOT NULL,
  storage_name  text        NOT NULL UNIQUE,
  visibility    text        NOT NULL CHECK (visibility IN ('public', 'private')),
  purpose       text        NOT NULL CHECK (purpose IN ('photo', 'thumbnail', 'lesson_file', 'lesson_video')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text        NOT NULL,
  password_hash      text,
  google_sub         text UNIQUE,
  name               text        NOT NULL CHECK (length(btrim(name)) > 0),   -- used on certificates
  phone              text,
  bio                text,
  expertise          text,
  photo_file_id      uuid REFERENCES files(id),
  role               user_role   NOT NULL DEFAULT 'student',
  is_root            boolean     NOT NULL DEFAULT false,                       -- the first Admin (AD-01)
  email_verified_at  timestamptz,
  is_active          boolean     NOT NULL DEFAULT true,
  deactivated_at     timestamptz,
  deactivated_reason text,
  totp_secret        text,
  totp_enabled       boolean     NOT NULL DEFAULT false,
  token_version      integer     NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE UNIQUE INDEX users_single_root     ON users (is_root) WHERE is_root;
ALTER TABLE files ADD CONSTRAINT files_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id);

-- AD-04 / AD-05 enforced in the database as well as in the application.
CREATE FUNCTION protect_users() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AD-05: accounts are deactivated, never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.is_root AND (NOT NEW.is_root OR NEW.role <> 'admin' OR NOT NEW.is_active) THEN
    RAISE EXCEPTION 'AD-04: the first Admin cannot be demoted or deactivated' USING ERRCODE = 'P0001';
  END IF;
  IF NOT OLD.is_root AND NEW.is_root THEN
    RAISE EXCEPTION 'AD-01: the first Admin can only be created by the seed script' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER users_protect BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION protect_users();

CREATE TABLE user_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id),
  purpose    text        NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'mfa_email')),
  token_hash text        NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_tokens_hash_idx ON user_tokens (token_hash);
CREATE INDEX user_tokens_user_idx ON user_tokens (user_id, purpose);

-- ---------------------------------------------------------------- teacher applications
CREATE TABLE teacher_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id),
  bio             text        NOT NULL,
  expertise       text        NOT NULL,
  credential_url  text,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decision_reason text,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'declined' OR length(btrim(coalesce(decision_reason, ''))) > 0)
);
CREATE UNIQUE INDEX teacher_app_one_pending ON teacher_applications (user_id) WHERE status = 'pending';

-- ---------------------------------------------------------------- courses
-- Metadata (title, summary, outline…) lives on `courses` and edits go live immediately.
-- Content (sections, lessons, quizzes, completion rule) lives in versioned rows;
-- the live version stays visible until a new version is approved (CR-04).
CREATE TABLE courses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id        uuid          NOT NULL REFERENCES users(id),
  title             text          NOT NULL,
  summary           text          NOT NULL DEFAULT '',
  description       text          NOT NULL DEFAULT '',
  outline           text          NOT NULL DEFAULT '',
  category          text          NOT NULL DEFAULT '',
  level             text          NOT NULL DEFAULT 'beginner' CHECK (level IN ('beginner', 'intermediate', 'advanced')),
  language          text          NOT NULL DEFAULT 'English',
  thumbnail_file_id uuid REFERENCES files(id),
  status            course_status NOT NULL DEFAULT 'draft',
  live_version_id   uuid,
  draft_version_id  uuid,
  published_at      timestamptz,
  archived_at       timestamptz,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX courses_status_idx  ON courses (status);
CREATE INDEX courses_teacher_idx ON courses (teacher_id);

CREATE TABLE course_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid           NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version_no   integer        NOT NULL,
  content      jsonb          NOT NULL,
  status       version_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  reviewed_at  timestamptz,
  reviewed_by  uuid REFERENCES users(id),
  created_at   timestamptz    NOT NULL DEFAULT now(),
  updated_at   timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (course_id, version_no)
);
CREATE INDEX course_versions_status_idx ON course_versions (status);
ALTER TABLE courses ADD CONSTRAINT courses_live_fk  FOREIGN KEY (live_version_id)  REFERENCES course_versions(id) ON DELETE SET NULL;
ALTER TABLE courses ADD CONSTRAINT courses_draft_fk FOREIGN KEY (draft_version_id) REFERENCES course_versions(id) ON DELETE SET NULL;

-- Every approval / rejection, with its reason, is kept (CR-03).
CREATE TABLE course_reviews (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  uuid        NOT NULL REFERENCES courses(id),          -- RESTRICT: reviewed courses cannot be deleted
  version_id uuid REFERENCES course_versions(id) ON DELETE SET NULL,
  version_no integer     NOT NULL,
  admin_id   uuid        NOT NULL REFERENCES users(id),
  decision   text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'rejected' OR length(btrim(coalesce(reason, ''))) > 0)
);
CREATE INDEX course_reviews_course_idx ON course_reviews (course_id, created_at DESC);

-- ---------------------------------------------------------------- learning
CREATE TABLE enrollments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users(id),
  course_id        uuid        NOT NULL REFERENCES courses(id),  -- RESTRICT: enrolled courses cannot be deleted (CR-05)
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'refunded')),
  enrolled_at      timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  last_item_id     text,
  last_accessed_at timestamptz
);
-- EN-01: at most one active enrolment per learner per course.
CREATE UNIQUE INDEX enrollments_one_active ON enrollments (user_id, course_id) WHERE status = 'active';
CREATE INDEX enrollments_course_idx ON enrollments (course_id);

CREATE TABLE lesson_progress (
  enrollment_id uuid        NOT NULL REFERENCES enrollments(id),
  lesson_id     text        NOT NULL,
  completed_at  timestamptz,
  position_sec  numeric(10, 2) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, lesson_id)
);

CREATE TABLE quiz_states (
  enrollment_id uuid        NOT NULL REFERENCES enrollments(id),
  quiz_id       text        NOT NULL,
  attempts_used integer     NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  passed_at     timestamptz,
  best_score    numeric(5, 2),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, quiz_id)
);

CREATE TABLE quiz_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid          NOT NULL REFERENCES enrollments(id),
  quiz_id       text          NOT NULL,
  score         numeric(5, 2) NOT NULL,
  passed        boolean       NOT NULL,
  answers       jsonb         NOT NULL,
  created_at    timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX quiz_attempts_idx ON quiz_attempts (enrollment_id, quiz_id, created_at DESC);

-- ---------------------------------------------------------------- certificates
CREATE TABLE certificates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  uuid        NOT NULL UNIQUE REFERENCES enrollments(id),   -- CC-02: one per completed course
  user_id        uuid        NOT NULL REFERENCES users(id),
  course_id      uuid        NOT NULL REFERENCES courses(id),
  code           text        NOT NULL UNIQUE,
  recipient_name text        NOT NULL,
  course_title   text        NOT NULL,
  teacher_name   text        NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES users(id),
  revoke_reason  text,
  CHECK (revoked_at IS NULL OR length(btrim(coalesce(revoke_reason, ''))) > 0)
);

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id),
  type       text        NOT NULL,
  title      text        NOT NULL,
  body       text        NOT NULL DEFAULT '',
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- ---------------------------------------------------------------- audit log (append-only)
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid REFERENCES users(id),
  actor_email text,
  actor_role  text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  old_values  jsonb,
  new_values  jsonb,
  ip          text,
  user_agent  text
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx   ON audit_logs (actor_id);
CREATE INDEX audit_logs_action_idx  ON audit_logs (action, target_id, created_at DESC);

CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_change   BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW       EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE          ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
