# Yapha LMS: multitenant e-learning platform

| | |
|---|---|
| **Product** | Yapha LMS (version 0.9.1) |
| **Owner / maintainer** | Mwanga Limited, registered in Nigeria |
| **Production** | https://learn.yapha.com |
| **Contact** | tech@mwanga.ng (support and security reports, see [SECURITY.md](SECURITY.md)) |
| **Licence** | Proprietary, all rights reserved ([LICENSE](LICENSE), [NOTICE](NOTICE)) |
| **Also see** | [CHANGELOG](CHANGELOG.md) · [CONTRIBUTING](CONTRIBUTING.md) · [API](API.md) · [TESTING](TESTING.md) · [Runbook](deploy/RUNBOOK.md) |

Yapha, a Mwanga Limited subsidiary, is the first organisation (tenant) on the platform.

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
- **Separate accounts per organisation.** The same email can join two organisations as two unrelated accounts with separate passwords. Each organisation has its own session cookie (`yapha_<slug>`), and a session from one organisation is rejected by every other.
- **Isolation enforced by PostgreSQL**, not just application code. Every table carries `tenant_id` and has a row-level security policy. Each API request runs in one transaction as the restricted role `yapha_app`, with `app.tenant_id` set to the organisation in the URL, so a query can only ever see or write that organisation's rows. This holds even if application code forgets a `WHERE` clause, and even when the app connects as the `postgres` superuser. See `migrations/003_tenant_isolation.sql`.
- **Per-organisation configuration** (Admin › Settings, or the platform console):
  - **Branding:** display name, logo, accent colour, main colour (header, headings, buttons) and a dark or light header. Used on every page, in emails (sender name) and on certificates.
  - **Quiz rules:** pass mark, attempts before lock, lock hours. Defaults: 70%, 3 and 24h.
  - **Who can join:** open sign-up or invite-only; optional allowed email domains (e.g. `acme.com`).
  - **Sign-in options:** Google on/off; require two-step sign-in for students too.
- **Organisations register themselves** at `/register`: organisation name, web address, and the details of the person registering, who becomes its first Admin (protected by AD-04, signs in with two steps). The organisation is live straight away with the default settings. The web address is checked live while typing. Registration is rate limited per network (`ORG_SIGNUP_PER_HOUR`, default 5 in production) and can be switched off with `ORG_SIGNUP=closed`. The super admin is emailed about each new organisation.
- **Platform super admin.** Created once by a seed script. Always signs in with two steps. Does **not** create organisations; oversees them: suspends and reactivates them, edits their settings, adds Admins (e.g. when an organisation's Admins have left), and sees people and audit logs across all organisations. Inside an organisation the super admin acts as an Admin, audited as `superadmin` and still bound by AD-04.
- **Invitations.** Admins invite Students or Teachers. The invitee gets a 7-day link to set their password, which also verifies their email. Invite-only organisations rely on this.

## Run it locally

Requirements: Node 20+ (the image uses 24), PostgreSQL 13+ (production uses 18). Nothing else: locally, files go to a folder, emails are printed in the terminal and no Google account is needed.

```bash
# 1. Database
createdb yapha_lms
createdb yapha_lms_test         # only needed to run the tests; it is erased on every run

# 2. Backend
cd backend
npm install
cp .env.example .env            # then edit: DATABASE_URL, SUPERADMIN_PASSWORD (12+ characters). Every setting is explained in the file.
npm run migrate                 # tables, row-level security, the yapha_app role
npm run seed:superadmin         # the platform super admin, once
npm run seed:demo               # optional: two demo organisations, "acme" and "globex"
npm run brand:yapha             # optional: Yapha's logo, orange accent, navy main colour and light header
npm run dev                     # API on http://localhost:4000

# 3. Frontend (second terminal)
cd frontend
npm install
npm run dev                     # http://localhost:5173 (proxies /api to the backend)
```

Then:
- **http://localhost:5173/register**: register a new organisation (you become its first Admin).
- **http://localhost:5173/platform**: super admin console, to oversee every organisation.
- **http://localhost:5173/acme** and **/globex**: the demo organisations. Every demo password is `Password123`:
  - `admin@acme.example.com` / `admin@globex.example.com`
  - `teacher@example.com`, `student@example.com` (separate accounts in each organisation)

With `MAIL_TRANSPORT=console` (the default without SMTP), every email is printed in the backend terminal: sign-in codes, invitations, verification and reset links. Emails are written to a queue table first; with the console transport they go out immediately. If you try real SMTP locally (`MAIL_TRANSPORT=smtp`), also run `npm run outbox:worker` in another terminal, which retries failed emails.

### What to change in `.env`

| Setting | Locally | Production |
|---|---|---|
| `DATABASE_URL` | your local Postgres | your Neon (or other PostgreSQL) connection string; on Google Cloud use the pooled URL and also set `DATABASE_URL_UNPOOLED` |
| `JWT_SECRET` | any string | **required**, 32+ random characters (`openssl rand -base64 48`) |
| `TOTP_ENCRYPTION_KEY` | leave empty (derived for development) | **required**, `openssl rand -base64 32`; back it up |
| `MAIL_TRANSPORT` | `console` | **must be `smtp`**, plus `SMTP_*` and `MAIL_FROM` with SPF/DKIM/DMARC |
| `STORAGE_DRIVER` | `disk` | `gcs` on Google Cloud (with `GCS_BUCKET`) |
| `APP_URL` | `http://localhost:5173` | your public `https://` address |
| `TRUST_PROXY` | unset | `1` (direct Cloud Run), `2` behind a load balancer |
| `RATE_LIMIT_STORE` | `memory` | `postgres` (the default in production) |

The app refuses to start in production with a weak secret, without the TOTP key, with the console mail transport, or with `STORAGE_DRIVER=gcs` and no bucket.

### Frontend commands

```bash
cd frontend
npm test            # unit and component tests (Vitest, Testing Library, MSW)
npm run lint        # oxlint
npm run build       # type-check + production build into frontend/dist
npm run e2e         # Playwright end-to-end (needs the backend running and E2E_DATABASE_URL; see TESTING.md)
```

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
createdb yapha_lms_test
cd backend && npm test          # backend tests; TEST_DATABASE_URL in .env (a separate database, erased on each run)
cd frontend && npm test         # Vitest + React Testing Library, no database needed
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
| `POST /api/:org/auth` | public | `me` (includes the organisation's public settings), `register`, `login`, `verifyMfa`, `sendMfaEmail`, `google`, `logout`, `verifyEmail`, `resendVerification`, `requestPasswordReset`, `resetPassword` (also accepts invitation links), `stopEmails` |
| `POST /api/:org/account` | signed in | `updateProfile`, `changePassword`, `totpSetup`, `totpEnable` (returns recovery codes), `totpDisable`, `regenerateRecoveryCodes`, `twoFactorStatus`, `notifications`, `markNotificationsRead`, `applyTeacher`, `myApplications`, `dashboard` |
| `POST /api/:org/courses` | public / Teacher / Admin | `catalog`, `detail`, `preview`, `mine`, `create`, `get`, `updateMeta`, `saveContent`, `startRevision`, `discardRevision`, `submit`, `publish`, `unpublish`, `archive`, `remove`, `learners`, `resetAttempts` |
| `POST /api/:org/learn` | Students | `enrol`, `player`, `lesson`, `savePosition`, `completeLesson`, `quiz`, `submitQuiz` |
| `POST /api/:org/admin` | Admin | `stats`, `reviewQueue`, `approveCourse`, `rejectCourse`, `courses`, `applications`, `decideApplication`, `users`, `changeRole`, `setActive`, `certificates`, `revokeCertificate`, `audit`, `auditCsv`, **`settings`**, **`updateSettings`**, **`inviteUser`**, **`resendInvite`**, **`resetTwoFactor`** |
| `POST /api/:org/upload/init`, `/upload/complete` | signed in | two-step upload: `init` says how (straight to the bucket with a signed address, or form), `complete` confirms it |
| `POST /api/:org/upload` | signed in | multipart `purpose` (`photo`, `thumbnail`, `lesson_file`, `lesson_video`, `logo`) + `file` (disk storage only) |
| `GET /api/:org/files/:id` | public / signed URL | the organisation's files only |
| `GET /api/:org/certificates/:code` | public | verification JSON (with member ID and issuer); `?format=pdf` returns the branded PDF |
| `POST /api/organisations` | public | `info` (is registration open), `checkAddress` (is a web address free), `register` (new organisation + its first Admin) |
| `POST /api/platform` | super admin | `me`, `login`, `verifyMfa`, `sendMfaEmail`, `logout`, `changePassword`, `totpSetup`, `totpEnable`, `stats`, `tenants`, `tenant`, `updateTenant`, `addTenantAdmin`, `users`, `audit`, `auditCsv` |

Plus `GET /api/health` (database, migrations, storage) and `POST /api/internal/outbox/drain`, `/api/internal/cleanup` (Cloud Scheduler only, Google identity token).

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

- Passwords hashed with bcrypt (cost 12). Sessions are a JWT in an `httpOnly`, `SameSite=strict` cookie per organisation (`yapha_<slug>`), plus `yapha_platform` for the super admin. Each token names its organisation and is rejected elsewhere. Sessions are revoked on password change or reset, role change and deactivation.
- Every API request is one transaction as role `yapha_app` (`NOBYPASSRLS`, no `DELETE` on users/tenants, no `UPDATE`/`DELETE` on the audit log), with the organisation set by the server from the URL, never by the client.
- The response is sent only after the transaction commits. Failed sign-ins and blocked attempts are kept in the audit log even when the request is refused.
- Login rate limiting per IP and per account; single-use, hashed, expiring links (verification 24h, reset 60 min, invitation 7 days).
- Helmet with a strict Content Security Policy; JSON-only POSTs; zod validation; quiz answers never sent to learners.
- **Authenticator app (2FA):** secrets are encrypted in the database (AES-256-GCM, `TOTP_ENCRYPTION_KEY`); each code works once; 10 single-use recovery codes are shown once at setup; with an app turned on, emailed codes are no longer accepted; turning it off needs the password and a code; admins can reset someone's 2FA (audited, the person is notified).
- **Email:** queued in the database in the same transaction as the action (nothing is sent if the action fails), retried on failure, sign-in codes expire after 10 minutes. One address can be invited at most 3 times a day and 10 times in 30 days across all organisations; every invitation has a "stop these emails" link that blocks that address everywhere.
- **Uploads:** size and type are checked before any bytes are accepted, the file's first bytes must match its claimed type, and each organisation has a storage cap. On Google Cloud the browser uploads straight to the bucket (the app never carries large files) and private files are served through short-lived signed addresses.

## Deploying

There are two supported ways to run this in production. Both refuse to start with weak or missing settings (see the table above).

### A. Google Cloud (recommended): `deploy/gcp/`

Cloud Run (the app) + Neon PostgreSQL (external; you pass its connection strings in) + Cloud Storage (uploads and an independent backup bucket in a second region) + Secret Manager + Cloud Scheduler (email retries every minute, hourly clean-up, nightly backup) + Cloud Monitoring (uptime check and alerts) + GitHub Actions for keyless deploys. Everything is defined in `deploy/gcp/terraform`.

**The full step-by-step guide, from an empty Google Cloud account to production, is `deploy/gcp/DEPLOY-GUIDE.md`.** In short (reference material is in `deploy/gcp/RUNBOOK.md`):

1. **Prerequisites:** a Google Cloud project with billing; `gcloud`, `terraform` (1.7+) and Docker on your machine; a domain; an SMTP provider with SPF, DKIM and DMARC set up for your sending domain; a GitHub repository.
2. **State bucket:** create a Cloud Storage bucket by hand for Terraform state (versioning on).
3. **Configure:** `cd deploy/gcp/terraform`, `cp terraform.tfvars.example terraform.tfvars`, fill it in (`project_id`, `region`, `app_url`, `domain`, `alert_email`, `github_repo`, `smtp_host`, `mail_from`), and export `TF_VAR_database_url`, `TF_VAR_database_url_unpooled` (Neon pooled and direct URLs) and `TF_VAR_smtp_password` (never commit them). Secrets that Terraform generates itself (`JWT_SECRET`, `TOTP_ENCRYPTION_KEY`, `METRICS_TOKEN`) go straight into Secret Manager.
4. **First image:** build and push it to the Artifact Registry repository, then put its tag in `image`.
5. **Create everything:** `terraform init -backend-config="bucket=<state bucket>"`, `terraform plan` (read it), `terraform apply`.
6. **Migrate and create the super admin:** `gcloud run jobs execute yapha-migrate --region REGION --wait`, then create the platform super admin once (RUNBOOK section 2).
7. **DNS:** add the records from `terraform output dns_records`.
8. **GitHub:** set the repository variables from `terraform output` (`GCP_PROJECT`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOYER_SA`), create the `production` environment with required reviewers, and run `deploy/github/apply-ruleset.sh owner/repo` for branch protection. From then on, merging to `main` deploys.
9. **Moving from an existing server:** copy uploaded files with `npm run files:to-gcs`, restore the database, then run the migrate job (it also encrypts existing authenticator secrets).
10. **Before launch:** run a restore drill (`deploy/gcp/restore-drill.sh`) and send a test invitation to Gmail and Outlook.

**Not yet run against a real Google Cloud project:** do the first deployment in a throwaway project.

### B. One server with Docker: `deploy/RUNBOOK.md`

Build the `Dockerfile`, copy `deploy/.env.production.example` to `deploy/.env.production`, fill it in (including `TOTP_ENCRYPTION_KEY`), then `docker compose --env-file deploy/.env.production up -d --build`. That starts PostgreSQL, a one-off migration step, the app and the email retry worker; put a TLS reverse proxy in front and set `TRUST_PROXY`. Connect as a database user that is **not** a superuser but owns its database and has `CREATEROLE` (the compose bootstrap does this); `npm run migrate` takes a lock, grants the runtime role and checks it works. Back up with `deploy/backup.sh` and practise `deploy/restore.sh`. Uploads live on a Docker volume here, so run **one** app instance.

`GET /api/health` reports database, migrations and storage; `GET /api/metrics` is available with `METRICS_TOKEN`.

### Useful scripts (`cd backend`)

| Command | What it does |
|---|---|
| `npm run migrate` | Apply database migrations (locked, safe to repeat) |
| `npm run secrets:encrypt-totp` | Encrypt authenticator secrets stored in clear; re-encrypt after a key rotation |
| `npm run outbox:worker` | Send queued emails and retry failed ones every minute (not needed on Google Cloud) |
| `npm run backup` | Cloud backup: database dump + file copy to `BACKUP_BUCKET` (the nightly job runs this) |
| `npm run files:to-gcs` | Copy existing disk uploads into the bucket (safe to repeat) |
| `npm run reset:superadmin-2fa` | Break-glass: remove the super admin's authenticator app (`SUPERADMIN_EMAIL=...`) |

## Course payments (Paystack)

- **Each organisation uses its own Paystack account.** An Admin enters the organisation's Paystack public and secret keys in **Admin › Settings › Payments**, and pastes the **webhook URL** shown there into Paystack (Settings › API Keys & Webhooks). Learners' money goes straight to that organisation's Paystack account.
- **The secret key is encrypted** in the database (AES-256-GCM). Set `DATA_ENCRYPTION_KEY` in `backend/.env` to a long random value and never change it (changing it means every organisation must enter its keys again). It is required in production. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- **Every course is paid.** The teacher must suggest a price on the course's Details tab before submitting. The Admin sets the real price when approving the course (it defaults to the suggestion) and can change it at any time from the course page (**Admin › All courses › course › Price**). A price must be above 0. A course without a price (for example one published before payments existed) is hidden from the catalogue, can't be published again and can't be joined until an Admin sets a price; learners who already joined keep access. The currency (NGN by default) is an organisation setting.
- **One payment gives full access** to the course, with no expiry. Learners who already have access keep it if the price changes later.
- **How a payment works:** the learner clicks **Buy** → Paystack's checkout page → Paystack sends them back to `/<organisation>/payment`, where the server asks Paystack how the payment went. The webhook confirms it as well, so access is given even if the learner closes the page. Only a payment Paystack confirms, for the exact price and currency, gives access. Admins see payments in **Admin › Payments**; learners see their receipts on **My learning** and by email.
- **Testing payments:** use Paystack **test** keys (`pk_test_…`, `sk_test_…`) and Paystack's test cards. No real money moves. Switch to live keys when ready.

## Branding: Yapha by default

- **The platform's own pages and emails use the Yapha brand**: the home page (`/`), Register your organisation (`/register`), the platform console (`/platform`), the browser tab name and icon, and emails sent by the platform (e.g. "New organisation registered"). Colours: orange `#FF950D`, navy `#030027`. The logo is `frontend/src/assets/yapha-logo.svg`; the values live in `PLATFORM_BRAND` (`backend/src/lib/tenant.js`) and `:root` in `frontend/src/styles.css`.
- **Every organisation starts with the Yapha look** (colours and light header). Its Admin can apply its own branding under **Admin › Settings** (logo, display name, colours, header); that replaces Yapha's on the organisation's pages, emails and certificates. Anything the organisation hasn't set stays Yapha's; an organisation without a logo shows its name.
- Set `MAIL_FROM="Yapha <no-reply@your-domain>"` in `backend/.env` so platform emails come from Yapha. Organisation emails are sent in the organisation's name.

## Referrals

- **Every teacher and student** has a referral code (8 characters, e.g. `PY8EFB2Q`), unique across the whole platform. They find it, with a Copy button and a link, under **Your account › Your referral code**.
- **Learners use a code when they enrol in a course**, not when they sign up: on the course page there's a **Referral code (optional)** box above **Enrol for ₦…**. A link like `/<organisation>?ref=CODE` fills the box in for them. A wrong code, the learner's own code, or a code from another organisation is refused before paying.
- The referral is recorded on the payment and, once Paystack confirms it, on the enrolment. It can't be changed afterwards.
- Because codes are used per course, referrals are shown **per course**: each course the code was used for, how many enrolled in it with the code, and who.
- **Teachers and students** see their totals (enrolments and courses) and, per course, each learner's name, date and email with most of it hidden (`b***@example.com`).
- **Admins** see **Admin › Referrals**: every member whose code was used, with the same totals and, per course, each learner's **full** email, name and date.

## Editing a published course

- **The course's teacher or an Admin** can edit a published course: its details (title, summary, description, outline, category, level, language, thumbnail), lessons, quizzes and completion rule. Admins open it from **Admin › All courses › course › Edit course**.
- **Edits go live only after an Admin approves them.** They are saved on a revision (started automatically on the first change); learners keep seeing the live course meanwhile. Submit the revision from the **Review** tab; the reviewing Admin sees the changed details next to the live ones. A rejected revision can be fixed and resubmitted; **Discard revision** throws the changes away.
- **Every edit is audited:** `course.edit` (details, with old and new values), `course.content_saved` (lessons and quizzes), then `course.submit` and `course.approve` / `course.reject`.
- The price is separate: only an Admin sets it, and it changes straight away. The web address never changes after publishing.

## Course web addresses

Courses have a readable address made from the title, e.g. `/yapha/courses/bookkeeping-for-small-businesses` and `/yapha/learn/bookkeeping-for-small-businesses`, instead of an ID. If two courses have the same title, the second gets `-2`. The address follows the title until the course is first published; after that it never changes, so shared links keep working. Old links with the course ID still work and move to the readable address.

## Google sign-in (optional)

Set `GOOGLE_CLIENT_ID` in `backend/.env`. Each organisation can turn the button off in its settings. New Google accounts follow the organisation's joining rules.

## Project layout

```
backend/
  migrations/001_init.sql             schema, constraints, protective triggers
  migrations/002_multitenancy.sql     tenants table, super admin role
  migrations/003_tenant_isolation.sql tenant_id everywhere, member IDs, row-level security, yapha_app role
  migrations/004_yapha.sql            the original organisation becomes Yapha at /yapha
  migrations/005_video_watch.sql      watched time per video lesson (videos complete only by watching)
  migrations/011_cloud.sql            email outbox, recovery codes, invitation limits, rate-limit counters, two-phase uploads
  src/app.js                          security headers, /api/:org and /api/platform, errors
  src/db.js                           per-request tenant scope (transaction + role + app.tenant_id)
  src/routes/index.js                 organisation resolution and request scoping
  src/routes/                         auth, account, courses, learn, admin, files, certificates, organisations (registration), platform
  src/lib/tenant.js                   organisation settings (schema, defaults), join rules
  src/lib/                            mailer + outbox (queue/retry), totp (encryption, recovery codes), storage (disk | gcs), mailguard
  src/scripts/                        migrate, seeds, backup, outbox-worker, encrypt-totp-secrets, files-to-gcs, 2FA reset
  test/                               rules, files/2FA, tenancy (isolation), hardening, cloud tests
frontend/
  src/main.tsx                        picks the app by address: /<org>, /platform or /
  src/App.tsx, src/pages/             an organisation's site (router basename /<org>)
  src/platform/                       super admin console
  src/components/SettingsForm.tsx     organisation settings editor (Admin and super admin)
frontend/e2e/                         Playwright end-to-end tests
deploy/gcp/                           Terraform, runbook and restore drill for Google Cloud
deploy/                               single-server runbook, backup/restore scripts, compose bootstrap
.github/                              CI, deploy, CodeQL, Dependabot, CODEOWNERS
postman/                              collection + environment (122 requests, 199 checks)
```
