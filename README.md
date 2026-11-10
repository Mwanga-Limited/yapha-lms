# E-Learning Platform: multitenant

One platform, many organisations (tenants). Each organisation (a school, company or academy) gets its own isolated e-learning site with its own Admins, Teachers, Students, courses, certificates, audit log and configuration. A **platform super admin** sees across all of them; organisations never see each other.

- **Backend:** Node.js (Express 5) + **PostgreSQL**, in `backend/`
- **Frontend:** React + **TypeScript** (Vite), in `frontend/`
- **Phase 1 rules (AD/CR/EN/QZ/CC)** apply inside every organisation, unchanged. Payments are Phase 2.

| Who | Where | What they see |
|---|---|---|
| Visitors, Students, Teachers, Admins | `/<organisation>/...` e.g. `/acme` | Only their organisation |
| Platform super admin | `/platform` | Every organisation: overview, organisations, people, audit log |
| Anyone without an address | `/` | "Find your organisation" (organisations are never listed publicly) |
| A new organisation | `/register` | Registers itself; the person registering becomes its first Admin |

Words the app uses for its own pages (`platform`, `register`, `api`, `admin`, `login` and a few more, listed in `RESERVED_SLUGS` in `backend/src/lib/tenant.js`) can't be an organisation's web address. Older links of the form `/t/<organisation>/...` are forwarded to `/<organisation>/...`. The API keeps its `/api/<organisation>/` prefix; only the page addresses changed.

## What multitenancy adds

- **Unique IDs.** Every organisation has a UUID and a web address (`slug`), which is permanent. Every member has a UUID plus a human-friendly **member ID** that is unique in their organisation, e.g. `ACME-000042`. It's shown on the profile, in Admin › Users and on certificates, and can never change.
- **Separate accounts per organisation.** The same email can join two organisations as two unrelated accounts with separate passwords. Each organisation has its own session cookie (`el_<slug>`), and a session from one organisation is rejected by every other.
- **Isolation enforced by PostgreSQL**, not just application code. Every table carries `tenant_id` and has a row-level security policy. Each API request runs in one transaction as the restricted role `elearning_app`, with `app.tenant_id` set to the organisation in the URL, so a query can only ever see or write that organisation's rows. This holds even if application code forgets a `WHERE` clause, and even when the app connects as the `postgres` superuser. See `migrations/003_tenant_isolation.sql`.
- **Per-organisation configuration** (Admin › Settings, or the platform console):
  - **Branding:** display name, logo, accent colour, main colour (header, headings, buttons) and a dark or light header. Used on every page, in emails (sender name) and on certificates.
  - **Quiz rules:** pass mark, attempts before lock, lock hours. Defaults: 70%, 3 and 24h.
  - **Who can join:** open sign-up or invite-only; optional allowed email domains (e.g. `acme.com`).
  - **Sign-in options:** Google on/off; require two-step sign-in for students too.
- **Organisations register themselves** at `/register`: organisation name, web address, and the details of the person registering, who becomes its first Admin (protected by AD-04, signs in with two steps). The organisation is live straight away with the default settings. The web address is checked live while typing. Registration is rate limited per network (`ORG_SIGNUP_PER_HOUR`, default 5 in production) and can be switched off with `ORG_SIGNUP=closed`. The super admin is emailed about each new organisation.
- **Platform super admin.** Created once by a seed script. Always signs in with two steps. Does **not** create organisations; oversees them: suspends and reactivates them, edits their settings, adds Admins (e.g. when an organisation's Admins have left), and sees people and audit logs across all organisations. Inside an organisation the super admin acts as an Admin, audited as `superadmin` and still bound by AD-04.
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
npm run brand:yapha             # optional: Yapha's logo, orange accent, navy main colour and light header
npm run dev                     # API on http://localhost:4000

# 3. Frontend (second terminal)
cd frontend
npm install
npm run dev                     # http://localhost:5173
```

Then:
- **http://localhost:5173/register**: register a new organisation (you become its first Admin).
- **http://localhost:5173/platform**: super admin console, to oversee every organisation.
- **http://localhost:5173/acme** and **/globex**: the demo organisations. Every demo password is `Password123`:
  - `admin@acme.example.com` / `admin@globex.example.com`
  - `teacher@example.com`, `student@example.com` (separate accounts in each organisation)

With `MAIL_TRANSPORT=console` (the default without SMTP), every email is printed in the backend terminal: sign-in codes, invitations, verification and reset links.

### Upgrading an existing (single-organisation) database

`npm run migrate` moves all existing data into an organisation called **Yapha** at `/yapha`. Nothing is lost:
- Existing users keep their passwords.
- The existing first Admin becomes that organisation's first Admin.
- Everyone gets a member ID (`YAPHA-000001`, …).

Then run `npm run seed:superadmin`. You can change Yapha's name and settings in the console; its web address stays `yapha`.

**Single deployment:** run `npm run build` in `frontend/`; the backend then serves `frontend/dist` itself.

## Tests

The full test plan (automated tests, the Postman collection in `postman/`, and a frontend walkthrough) is in **TESTING.md**.

```bash
createdb elearning_test
cd backend && npm test          # 50 tests; TEST_DATABASE_URL in .env (a separate database, erased on each run)
cd frontend && npm test         # 21 tests (Vitest + React Testing Library), no database needed
```

`test/tenancy.test.js` attacks the isolation directly:
- cross-organisation reads and writes through the API
- reusing a session in another organisation
- certificates and files fetched through another organisation
- raw SQL as the app role, which proves PostgreSQL refuses it

## API

Each organisation has the same 8 endpoints under **`/api/<organisation>/`**, plus **`/api/organisations`** (public registration) and **`/api/platform`** (the super admin console). Every POST is `{ "action": "...", "data": {...} }`. **API.md** has every action with a ready-to-paste Postman body.

| Endpoint | Who | Actions |
|---|---|---|
| `POST /api/:org/auth` | public | `me` (includes the organisation's public settings), `register`, `login`, `verifyMfa`, `sendMfaEmail`, `google`, `logout`, `verifyEmail`, `resendVerification`, `requestPasswordReset`, `resetPassword` (also accepts invitation links) |
| `POST /api/:org/account` | signed in | `updateProfile`, `changePassword`, `totpSetup`, `totpEnable`, `totpDisable`, `notifications`, `markNotificationsRead`, `applyTeacher`, `myApplications`, `dashboard` |
| `POST /api/:org/courses` | public / Teacher / Admin | `catalog`, `detail`, `preview`, `mine`, `create`, `get`, `updateMeta`, `saveContent`, `startRevision`, `discardRevision`, `submit`, `publish`, `unpublish`, `archive`, `remove`, `learners`, `resetAttempts` |
| `POST /api/:org/learn` | Students | `enrol`, `player`, `lesson`, `savePosition`, `completeLesson`, `quiz`, `submitQuiz` |
| `POST /api/:org/admin` | Admin | `stats`, `reviewQueue`, `approveCourse`, `rejectCourse`, `courses`, `applications`, `decideApplication`, `users`, `changeRole`, `setActive`, `certificates`, `revokeCertificate`, `audit`, `auditCsv`, **`settings`**, **`updateSettings`**, **`inviteUser`** |
| `POST /api/:org/upload` | signed in | multipart `purpose` (`photo`, `thumbnail`, `lesson_file`, `lesson_video`, `logo`) + `file` |
| `GET /api/:org/files/:id` | public / signed URL | the organisation's files only |
| `GET /api/:org/certificates/:code` | public | verification JSON (with member ID and issuer); `?format=pdf` returns the branded PDF |
| `POST /api/organisations` | public | `info` (is registration open), `checkAddress` (is a web address free), `register` (new organisation + its first Admin) |
| `POST /api/platform` | super admin | `me`, `login`, `verifyMfa`, `sendMfaEmail`, `logout`, `changePassword`, `totpSetup`, `totpEnable`, `stats`, `tenants`, `tenant`, `updateTenant`, `addTenantAdmin`, `users`, `audit`, `auditCsv` |

Plus `GET /api/health`, which also checks that the database answers.

## How the rules are enforced

All Phase 1 rules apply **within each organisation**:

| Rule | Where |
|---|---|
| AD-01 first Admin | Platform: one super admin by `seed:superadmin`. Per organisation: the person who registers it (`organisations.register`) is its first Admin; one `is_root` per organisation (unique index); a trigger blocks setting `is_root` later |
| AD-02 public sign-up | `auth.register` always creates a Student, if the organisation allows sign-up (open, allowed domains) |
| AD-03 Admin changes roles | `admin.changeRole`, inside the Admin's organisation only |
| AD-04 Admin protection | `admin.changeRole` / `admin.setActive` **and** a DB trigger on `users`; applies to the super admin too |
| AD-05 deactivate, never delete | no delete action; DB trigger and missing `DELETE` grant on `users` |
| AD-06 audit role changes and blocked attempts | logged even though the action is refused; each organisation sees only its own log |
| AD-07 2FA for Admins and Teachers | always; optionally for Students (organisation setting); always for the super admin |
| AD-08 becoming a Teacher | application approved by an Admin, an Admin role change, or an Admin invitation as Teacher |
| CR-01 … CR-05 | unchanged (see `routes/courses.js`, `routes/admin.js`) |
| EN-01 … EN-03 | unchanged; Students only enrol |
| Video lessons | complete only by watching (90% of the video, skipping ahead not counted): `learn.savePosition` completes them; `learn.completeLesson` refuses an unwatched video (`WATCH_VIDEO`) |
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

## Course payments (Paystack)

- **Each organisation uses its own Paystack account.** An Admin enters the organisation's Paystack public and secret keys in **Admin › Settings › Payments**, and pastes the **webhook URL** shown there into Paystack (Settings › API Keys & Webhooks). Learners' money goes straight to that organisation's Paystack account.
- **The secret key is encrypted** in the database (AES-256-GCM). Set `DATA_ENCRYPTION_KEY` in `backend/.env` to a long random value and never change it (changing it means every organisation must enter its keys again). It is required in production. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- **Every course is paid.** The teacher must suggest a price on the course's Details tab before submitting. The Admin sets the real price when approving the course (it defaults to the suggestion) and can change it at any time from the course page (**Admin › All courses › course › Price**). A price must be above 0. A course without a price (for example one published before payments existed) is hidden from the catalogue, can't be published again and can't be joined until an Admin sets a price; learners who already joined keep access. The currency (NGN by default) is an organisation setting.
- **One payment gives full access** to the course, with no expiry. Learners who already have access keep it if the price changes later.
- **How a payment works:** the learner clicks **Buy** → Paystack's checkout page → Paystack sends them back to `/<organisation>/payment`, where the server asks Paystack how the payment went. The webhook confirms it as well, so access is given even if the learner closes the page. Only a payment Paystack confirms, for the exact price and currency, gives access. Admins see payments in **Admin › Payments**; learners see their receipts on **My learning** and by email.
- **Testing payments:** use Paystack **test** keys (`pk_test_…`, `sk_test_…`) and Paystack's test cards. No real money moves. Switch to live keys when ready.

## Google sign-in (optional)

Set `GOOGLE_CLIENT_ID` in `backend/.env`. Each organisation can turn the button off in its settings. New Google accounts follow the organisation's joining rules.

## Project layout

```
backend/
  migrations/001_init.sql             schema, constraints, protective triggers
  migrations/002_multitenancy.sql     tenants table, super admin role
  migrations/003_tenant_isolation.sql tenant_id everywhere, member IDs, row-level security, elearning_app role
  migrations/004_yapha.sql            the original organisation becomes Yapha at /yapha
  migrations/005_video_watch.sql      watched time per video lesson (videos complete only by watching)
  src/app.js                          security headers, /api/:org and /api/platform, errors
  src/db.js                           per-request tenant scope (transaction + role + app.tenant_id)
  src/routes/index.js                 organisation resolution and request scoping
  src/routes/                         auth, account, courses, learn, admin, files, certificates, organisations (registration), platform
  src/lib/tenant.js                   organisation settings (schema, defaults), join rules
  src/scripts/                        migrate, seed-superadmin, seed-demo
  test/                               rules, files/2FA, tenancy (isolation) tests
frontend/
  src/main.tsx                        picks the app by address: /<org>, /platform or /
  src/App.tsx, src/pages/             an organisation's site (router basename /<org>)
  src/platform/                       super admin console
  src/components/SettingsForm.tsx     organisation settings editor (Admin and super admin)
postman/                              collection + environment (127 requests, 209 checks)
```
