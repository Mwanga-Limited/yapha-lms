# E-Learning Platform: multitenant

One platform, many organisations (tenants). Each organisation (a school, company or academy) gets its own isolated e-learning site with its own Admins, Teachers, Students, courses, certificates, audit log and configuration. A **platform super admin** sees across all of them; organisations never see each other.

- **Backend:** Node.js (Express 5) + **PostgreSQL**, in `backend/`
- **Frontend:** React + **TypeScript** (Vite), in `frontend/`
- **Phase 1 rules (AD/CR/EN/QZ/CC)** apply inside every organisation, unchanged.

| Who | Where | What they see |
|---|---|---|
| Visitors, Students, Teachers, Admins | `/t/<organisation>/...` e.g. `/t/acme` | Only their organisation |
| Platform super admin | `/platform` | Every organisation: overview, organisations, people, audit log |
| Anyone without an address | `/` | "Find your organisation" (organisations are never listed publicly) |

## What multitenancy adds

- **Unique IDs.** Every organisation has a UUID and a web address (`slug`), which is permanent. Every member has a UUID plus a human-friendly **member ID** that is unique in their organisation, e.g. `ACME-000042`. It's shown on the profile, in Admin › Users and on certificates, and can never change.
- **Separate accounts per organisation.** The same email can join two organisations as two unrelated accounts with separate passwords. Each organisation has its own session cookie (`el_<slug>`), and a session from one organisation is rejected by every other.
- **Isolation enforced by PostgreSQL**, not just application code. Every table carries `tenant_id` and has a row-level security policy. Each API request runs in one transaction as the restricted role `elearning_app`, with `app.tenant_id` set to the organisation in the URL, so a query can only ever see or write that organisation's rows. This holds even if application code forgets a `WHERE` clause, and even when the app connects as the `postgres` superuser. See `migrations/003_tenant_isolation.sql`.
- **Per-organisation configuration** (Admin › Settings, or the platform console):
  - **Branding:** display name, logo, accent colour. Used on every page, in emails (sender name) and on certificates.
  - **Quiz rules:** pass mark, attempts before lock, lock hours. Defaults: 70%, 3 and 24h.
  - **Who can join:** open sign-up or invite-only; optional allowed email domains (e.g. `acme.com`).
  - **Sign-in options:** Google on/off; require two-step sign-in for students too.
- **Platform super admin.** Created once by a seed script. Always signs in with two steps. Can create organisations (with their first Admin, invited by email), suspend and reactivate them, edit their settings, add Admins, and see people and audit logs across all organisations. Inside an organisation the super admin acts as an Admin, audited as `superadmin` and still bound by AD-04.
- **Invitations.** Admins invite Students or Teachers. The invitee gets a 7-day link to set their password, which also verifies their email. Invite-only organisations rely on this.

## Quick start

Requirements: Node 20+, PostgreSQL 13+.

```bash
# 1. Database
createdb elearning

# 2. Backend
cd backend
npm install
cp .env.example .env            # set DATABASE_URL, JWT_SECRET, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD
npm run migrate                 # tables, row-level security, the elearning_app role
npm run seed:superadmin         # the platform super admin, once
npm run seed:demo               # optional: two demo organisations, "acme" and "globex"
npm run dev                     # API on http://localhost:4000

# 3. Frontend (second terminal)
cd frontend
npm install
npm run dev                     # http://localhost:5173
```

Then:
- **http://localhost:5173/platform**: super admin console. Create organisations here.
- **http://localhost:5173/t/acme** and **/t/globex**: the demo organisations. Every demo password is `Password123`:
  - `admin@acme.example.com` / `admin@globex.example.com`
  - `teacher@example.com`, `student@example.com` (separate accounts in each organisation)

With `MAIL_TRANSPORT=console` (the default without SMTP), every email is printed in the backend terminal: sign-in codes, invitations, verification and reset links.

### Upgrading an existing (single-organisation) database

`npm run migrate` moves all existing data into an organisation called **Yapha** at `/t/yapha`. Nothing is lost:
- Existing users keep their passwords.
- The existing first Admin becomes that organisation's first Admin.
- Everyone gets a member ID (`YAPHA-000001`, …).

Then run `npm run seed:superadmin`. You can change Yapha's name and settings in the console; its web address stays `yapha`.

**Single deployment:** run `npm run build` in `frontend/`; the backend then serves `frontend/dist` itself.

## Tests

The full test plan (automated tests, the Postman collection in `postman/`, and a frontend walkthrough) is in **TESTING.md**.

```bash
createdb elearning_test
cd backend && npm test          # 43 tests; TEST_DATABASE_URL in .env (a separate database, erased on each run)
```

`test/tenancy.test.js` attacks the isolation directly:
- cross-organisation reads and writes through the API
- reusing a session in another organisation
- certificates and files fetched through another organisation
- raw SQL as the app role, which proves PostgreSQL refuses it

## API

Each organisation has the same 8 endpoints under **`/api/t/<organisation>/`**, and the super admin console has **one** more. Every POST is `{ "action": "...", "data": {...} }`. **API.md** has every action with a ready-to-paste Postman body.

| Endpoint | Who | Actions |
|---|---|---|
| `POST /api/t/:org/auth` | public | `me` (includes the organisation's public settings), `register`, `login`, `verifyMfa`, `sendMfaEmail`, `google`, `logout`, `verifyEmail`, `resendVerification`, `requestPasswordReset`, `resetPassword` (also accepts invitation links) |
| `POST /api/t/:org/account` | signed in | `updateProfile`, `changePassword`, `totpSetup`, `totpEnable`, `totpDisable`, `notifications`, `markNotificationsRead`, `applyTeacher`, `myApplications`, `dashboard` |
| `POST /api/t/:org/courses` | public / Teacher / Admin | `catalog`, `detail`, `preview`, `mine`, `create`, `get`, `updateMeta`, `saveContent`, `startRevision`, `discardRevision`, `submit`, `publish`, `unpublish`, `archive`, `remove`, `learners`, `resetAttempts` |
| `POST /api/t/:org/learn` | Students | `enrol`, `player`, `lesson`, `savePosition`, `completeLesson`, `quiz`, `submitQuiz` |
| `POST /api/t/:org/admin` | Admin | `stats`, `reviewQueue`, `approveCourse`, `rejectCourse`, `courses`, `applications`, `decideApplication`, `users`, `changeRole`, `setActive`, `certificates`, `revokeCertificate`, `audit`, `auditCsv`, **`settings`**, **`updateSettings`**, **`inviteUser`** |
| `POST /api/t/:org/upload` | signed in | multipart `purpose` (`photo`, `thumbnail`, `lesson_file`, `lesson_video`, `logo`) + `file` |
| `GET /api/t/:org/files/:id` | public / signed URL | the organisation's files only |
| `GET /api/t/:org/certificates/:code` | public | verification JSON (with member ID and issuer); `?format=pdf` returns the branded PDF |
| `POST /api/platform` | super admin | `me`, `login`, `verifyMfa`, `sendMfaEmail`, `logout`, `changePassword`, `totpSetup`, `totpEnable`, `stats`, `tenants`, `tenant`, `createTenant`, `updateTenant`, `addTenantAdmin`, `users`, `audit`, `auditCsv` |

Plus `GET /api/health`, which also checks that the database answers.

## How the rules are enforced

All Phase 1 rules apply **within each organisation**:

| Rule | Where |
|---|---|
| AD-01 first Admin | Platform: one super admin by `seed:superadmin`. Per organisation: its first Admin is created with it by `createTenant`; one `is_root` per organisation (unique index); a trigger blocks setting `is_root` later |
| AD-02 public sign-up | `auth.register` always creates a Student, if the organisation allows sign-up (open, allowed domains) |
| AD-03 Admin changes roles | `admin.changeRole`, inside the Admin's organisation only |
| AD-04 Admin protection | `admin.changeRole` / `admin.setActive` **and** a DB trigger on `users`; applies to the super admin too |
| AD-05 deactivate, never delete | no delete action; DB trigger and missing `DELETE` grant on `users` |
| AD-06 audit role changes and blocked attempts | logged even though the action is refused; each organisation sees only its own log |
| AD-07 2FA for Admins and Teachers | always; optionally for Students (organisation setting); always for the super admin |
| AD-08 becoming a Teacher | application approved by an Admin, an Admin role change, or an Admin invitation as Teacher |
| CR-01 … CR-05 | unchanged (see `routes/courses.js`, `routes/admin.js`) |
| EN-01 … EN-03 | unchanged; Students only enrol |
| QZ-01 / QZ-02 | pass mark, attempts and lock hours from the organisation's settings (defaults 70% / 3 / 24h) |
| CC-01 … CC-03 | unchanged; certificates carry the organisation name and the learner's member ID |
| Isolation between organisations | row-level security on every table (`003_tenant_isolation.sql`), restricted role per request, per-organisation cookies, organisation-checked 2FA and invitation tokens |
| Audit log append-only | triggers refuse UPDATE/DELETE/TRUNCATE; the runtime role has no UPDATE/DELETE grant |

## Security notes

- Passwords hashed with bcrypt (cost 12). Sessions are a JWT in an `httpOnly`, `SameSite=strict` cookie per organisation (`el_<slug>`), plus `el_platform` for the super admin. Each token names its organisation and is rejected elsewhere. Sessions are revoked on password change or reset, role change and deactivation.
- Every API request is one transaction as role `elearning_app` (`NOBYPASSRLS`, no `DELETE` on users/tenants, no `UPDATE`/`DELETE` on the audit log), with the organisation set by the server from the URL, never by the client.
- The response is sent only after the transaction commits. Failed sign-ins and blocked attempts are kept in the audit log even when the request is refused.
- Login rate limiting per IP and per account; single-use, hashed, expiring links (verification 24h, reset 60 min, invitation 7 days).
- Helmet with a strict Content Security Policy; JSON-only POSTs; zod validation; quiz answers never sent to learners.
- **Production:** set `NODE_ENV=production`, a long random `JWT_SECRET`, `COOKIE_SECURE=true` behind HTTPS, and real SMTP. Ideally, connect as a database owner that is **not** a superuser; `npm run migrate` grants it membership of `elearning_app`.

## Google sign-in (optional)

Set `GOOGLE_CLIENT_ID` in `backend/.env`. Each organisation can turn the button off in its settings. New Google accounts follow the organisation's joining rules.

## Project layout

```
backend/
  migrations/001_init.sql             schema, constraints, protective triggers
  migrations/002_multitenancy.sql     tenants table, super admin role
  migrations/003_tenant_isolation.sql tenant_id everywhere, member IDs, row-level security, elearning_app role
  migrations/004_yapha.sql  the original organisation becomes Yapha at /t/yapha
  src/app.js                          security headers, /api/t/:org and /api/platform, errors
  src/db.js                           per-request tenant scope (transaction + role + app.tenant_id)
  src/routes/index.js                 organisation resolution and request scoping
  src/routes/                         auth, account, courses, learn, admin, files, certificates, platform
  src/lib/tenant.js                   organisation settings (schema, defaults), join rules
  src/scripts/                        migrate, seed-superadmin, seed-demo
  test/                               rules, files/2FA, tenancy (isolation) tests
frontend/
  src/main.tsx                        picks the app by address: /t/<org>, /platform or /
  src/App.tsx, src/pages/             an organisation's site (router basename /t/<org>)
  src/platform/                       super admin console
  src/components/SettingsForm.tsx     organisation settings editor (Admin and super admin)
postman/                              collection + environment (120 requests, 196 checks)
```
