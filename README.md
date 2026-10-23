# E-Learning Platform — Phase 1 MVP

Students take courses, Teachers build and submit courses for approval, Admins run the platform.

- **Backend:** Node.js (Express 5) + **PostgreSQL**, in `backend/`
- **Frontend:** React + **TypeScript** (Vite), in `frontend/`
- **Payments** (gateway, refunds, disputes) are Phase 2 and not included. The code has a hook ready for CC-03 refund revocation (`revokeCertificateForEnrollment` in `backend/src/lib/learning.js`).

## Quick start

Requirements: Node 20+, PostgreSQL 13+.

```bash
# 1. Database
createdb elearning

# 2. Backend
cd backend
npm install
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm run migrate               # creates tables, triggers and constraints
npm run seed:admin            # AD-01: creates the first Admin, once
npm run seed:demo             # optional: a demo Teacher, Student and published course
npm run dev                   # API on http://localhost:4000

# 3. Frontend (second terminal)
cd frontend
npm install
npm run dev                   # http://localhost:5173 (proxies /api to :4000)
```

With `MAIL_TRANSPORT=console` (the default without SMTP), every email — verification links, reset links and **2FA sign-in codes** — is printed in the backend terminal. Set the `SMTP_*` variables to send real email.

Demo accounts after `seed:demo`: `student@example.com` / `Password123` and `teacher@example.com` / `Password123`. Teachers and Admins get a second-factor code by email (or from an authenticator app once set up on the Profile page).

**Single deployment:** run `npm run build` in `frontend/`; the backend then serves `frontend/dist` itself, so one Node process serves the whole app.

## Tests

```bash
createdb elearning_test
cd backend && npm test        # uses TEST_DATABASE_URL, default postgres://postgres@localhost:5432/elearning_test
```

27 tests run against a real PostgreSQL database and cover role rules, course approval, enrolment access, quiz attempts, certificate issue/revocation, 2FA, private files and audit-log immutability. Each rule ID (AD-, CR-, EN-, QZ-, CC-) is named in the test titles.

## API: 8 endpoints

Each area has **one** endpoint. You send `POST { "action": "...", "data": {...} }`.

| Endpoint | Who | Actions |
|---|---|---|
| `POST /api/auth` | public | `me`, `register`, `login`, `verifyMfa`, `sendMfaEmail`, `google`, `logout`, `verifyEmail`, `resendVerification`, `requestPasswordReset`, `resetPassword` |
| `POST /api/account` | signed in | `updateProfile`, `changePassword`, `totpSetup`, `totpEnable`, `totpDisable`, `notifications`, `markNotificationsRead`, `applyTeacher`, `myApplications`, `dashboard` |
| `POST /api/courses` | public + Teacher/Admin | `catalog`, `detail`, `preview` · `mine`, `create`, `get`, `updateMeta`, `saveContent`, `startRevision`, `discardRevision`, `submit`, `publish`, `unpublish`, `archive`, `remove`, `learners`, `resetAttempts` |
| `POST /api/learn` | signed in | `enrol`, `player`, `lesson`, `savePosition`, `completeLesson`, `quiz`, `submitQuiz` |
| `POST /api/admin` | Admin | `stats`, `reviewQueue`, `approveCourse`, `rejectCourse`, `courses`, `applications`, `decideApplication`, `users`, `changeRole`, `setActive`, `certificates`, `revokeCertificate`, `audit`, `auditCsv` |
| `POST /api/upload` | signed in | multipart `purpose` (`photo`, `thumbnail`, `lesson_file`, `lesson_video`) + `file` |
| `GET /api/files/:id` | public / signed URL | public images; private lesson files only through short-lived signed links issued after an enrolment check |
| `GET /api/certificates/:code` | public | verification JSON; `?format=pdf` returns the certificate PDF |

Plus `GET /api/health`.

## How the rules are enforced

| Rule | Where |
|---|---|
| AD-01 first Admin by seed script | `seed-admin.js`; unique index allows one `is_root` user; trigger blocks setting `is_root` later |
| AD-02 public sign-up | `auth.register` always creates a Student |
| AD-03 Admin changes roles | `admin.changeRole` |
| AD-04 Admins can't demote/suspend other Admins; first Admin protected | `admin.changeRole` / `admin.setActive`, **and** a DB trigger on `users` |
| AD-05 deactivate, never delete | no delete action; DB trigger refuses `DELETE FROM users` |
| AD-06 role changes and blocked attempts logged | `user.role_change`, `user.role_change_blocked`, `user.deactivate_blocked` (logged even though the action is refused) |
| AD-07 2FA for Admins and Teachers | login returns an MFA step; authenticator app (TOTP) or emailed code. Role changes sign the user out so 2FA applies at once |
| AD-08 becoming a Teacher | the "Teach" option at sign-up (or later from the Teach page) creates an instructor application; the account becomes Teacher only when an Admin approves it, or via an Admin role change |
| CR-01 submission requirements | `submissionProblems()` checks outline, ≥1 lesson, ≥1 quiz, completion rule (and that each item is complete) |
| CR-02 only Admin approves; only approved publishes | `admin.approveCourse`; `courses.publish` needs `approved`/`unpublished` |
| CR-03 rejection reason kept; resubmit | `course_reviews` table (DB check: rejection needs a reason; reviewed courses can't be deleted) |
| CR-04 re-approval of content changes | lessons, quizzes and the completion rule live in versioned rows; a published course gets a *revision*; the live version serves learners until the revision is approved. Title/summary/outline/thumbnail edits go live immediately (minor edits) |
| CR-05 unpublish/archive, no delete with enrolments | access checks use enrolment, not catalog status; FK from `enrollments` blocks deletion |
| EN-01 one active enrolment | partial unique index `enrollments_one_active` |
| EN-02 enrolled only | every `learn.*` action checks the enrolment; private files need signed links; free-preview lessons are the explicit exception |
| EN-03 verified email before enrol/submit | `verified: true` on `learn.enrol` and `courses.submit` |
| QZ-01/02 70%, 3 attempts, 24h lock, resets | `learn.submitQuiz` (row lock per learner), `courses.resetAttempts` (course Teacher or Admin) |
| CC-01/02 completion and one certificate | `checkCompletion()`; `certificates.enrollment_id` is unique |
| CC-03 revoke with reason | `admin.revokeCertificate`; verification page and PDF reflect it |
| Audit log append-only | triggers refuse UPDATE/DELETE/TRUNCATE; optional `APP_DB_USER` runtime role is granted only SELECT/INSERT on `audit_logs` |

## Security notes

- Passwords hashed with bcrypt (cost 12); JWT session in an `httpOnly`, `SameSite=strict` cookie; sessions are revoked on password change/reset, role change and deactivation (`token_version`).
- Login rate limiting: per IP on `/api/auth` and a per-account lock after 5 failures in 15 minutes (also for wrong 2FA codes).
- Reset and verification links are single-use, hashed in the database, and expire (60 min / 24 h).
- Helmet with a strict Content Security Policy; JSON-only POSTs; input validated with zod; quiz answers are never sent to learners.
- For production, set `NODE_ENV=production`, a long random `JWT_SECRET`, `COOKIE_SECURE=true` behind HTTPS, real SMTP and, ideally, a separate least-privilege `APP_DB_USER`:

```sql
CREATE ROLE elearning_app LOGIN PASSWORD '...';
-- run `npm run migrate` as the owner with APP_DB_USER=elearning_app, then start the API with
-- DATABASE_URL pointing at elearning_app.
```

## Google sign-in (optional)

Create an OAuth client ID ("Web application") in Google Cloud, add your site origin, and set `GOOGLE_CLIENT_ID` in `backend/.env`. The button appears on the sign-in and sign-up pages automatically.

## Project layout

```
backend/
  migrations/001_init.sql      schema, constraints, protective triggers
  src/app.js                   the 8 endpoints, security headers, error handling
  src/routes/                  auth, account, courses, learn, admin, files, certificates
  src/lib/                     content rules, learning/certificates, audit, mail, security
  src/scripts/                 migrate, seed-admin, seed-demo
  test/                        node:test + supertest
frontend/
  src/api.ts                   typed client for the action endpoints
  src/pages/                   auth, catalog, course page, player, teacher, admin screens
  src/components/              layout + bell, lesson view, content builder preview, learners
```
