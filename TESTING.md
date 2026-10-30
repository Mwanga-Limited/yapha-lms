# Testing the E-Learning Platform (Phase 1, multitenant)

There are three layers of testing. Each one proves something different:

| Layer | What it proves | Time | Who |
|---|---|---|---|
| **1. Automated tests** (`npm test`) | Every business rule holds, against a real PostgreSQL database. Runs the same way every time. | ~5 s | Anyone, repeatable |
| **2. Postman collection** | The HTTP API behaves as documented, end to end, across all roles, the super admin and two organisations. 120 requests and 196 checks. | ~1 min | Engineer reviewing the API |
| **3. Frontend walkthrough** | The screens work for real people on desktop and mobile. | ~30 min | Anyone, by hand |

Rule IDs (AD-, CR-, EN-, QZ-, CC-) come from the work plan; they now apply inside each organisation. Isolation between organisations is tested separately (section 1 and Postman folder 10). The [coverage matrix](#4-rule-coverage-matrix) at the end shows where each rule is tested.

---

## 0. One-time setup

This assumes the app already runs locally (see README.md): API on `http://localhost:4000`, frontend on `http://localhost:5173`, and `npm run seed:superadmin` and `npm run seed:demo` already done. The demo creates two organisations: **acme** (open sign-up, default quiz rules) and **globex** (invite-only, 80% pass mark, 2 attempts).

Create a **separate** database for the automated tests. It is erased on every run.

```powershell
createdb -U postgres -p 5000 elearning_test


For safety, the tests refuse to run if this points at the main database, or if the database name does not contain "test".

---

## 1. Automated tests

```powershell
cd backend
npm test               # 43 tests, expect: pass 43, fail 0
npm run test:coverage  # same tests plus a coverage table (about 92% of lines)
```

What runs:

- `test/rules.test.js` covers authentication, rate limiting, password reset, 2FA, role checks, every AD/CR/EN/QZ/CC rule, the audit log and notifications.
- `test/files-totp.test.js` covers authenticator-app sign-in, uploads, signed private-file links, and teachers referencing files they don't own.
- `test/tenancy.test.js` covers multitenancy:
  - **Member IDs.** Unique organisation and member IDs, which never change.
  - **Separate accounts.** The same email is a separate account per organisation.
  - **Sessions.** A session from one organisation is rejected by another.
  - **API isolation.** Courses, users, reviews, audit entries, certificates and files of another organisation are invisible or "not found".
  - **Database isolation.** Raw SQL as the app role proves PostgreSQL itself enforces it, through row-level security.
  - **Per-organisation settings.** Quiz rules, allowed domains, invite-only, invitations, student 2FA and branding each work per organisation.
  - **Super admin.** Two-step sign-in, a view across organisations, creating an organisation with its first Admin, acting inside an organisation (audited, still bound by AD-04), and suspending one.

The tests use real HTTP requests (supertest) against the real Express app and a real PostgreSQL database. They also check that the **database itself** refuses forbidden changes:

- updating or deleting the audit log
- deleting a user
- demoting the first Admin
- a duplicate enrolment
- deleting a course that has enrolments

Emails are captured in memory, so the tests read verification links and 2FA codes from them, just as a user would.

---

## 2. Postman

Files are in the `postman/` folder:

- `E-Learning.postman_collection.json`: nine folders, run in order
- `E-Learning.local.postman_environment.json`: URLs, accounts and 2FA settings

### Import

1. In Postman, choose **Import**, then drop in both files.
2. In the top-right environment picker, select **E-Learning (local, multitenant)**.
3. Open the environment and set:
   - `superadminEmail` and `superadminPassword` to `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` from `backend/.env`
   - `tenant` (default `acme`) and `otherTenant` (default `globex`): the two organisations used
   - the admin, teacher and student accounts, which already match `npm run seed:demo` in `acme`

### 2FA: choose one option

Super admin, Admin and Teacher sign-ins need a second factor (AD-07). The collection handles it two ways.

**Option A: automatic (recommended, lets the Collection Runner run everything unattended).**

1. Sign in to the website as the Admin. Go to **Profile**, then **Set up an authenticator app**.
2. Scan the QR code with an authenticator app (Google or Microsoft Authenticator) and enter its code to turn it on.
3. Copy the key shown under the QR code into the Postman environment variable `adminTotpSecret`.
4. Repeat for `teacher@example.com` in acme (`teacherTotpSecret`), and for the super admin under **Your account** in the platform console (`superadminTotpSecret`).

Postman then generates the 6-digit code itself before each "step 2" request.

**Option B: manual.** Leave the secrets empty.

1. Send "Sign in as admin (step 1: password)".
2. Copy the code printed in the API terminal (`[mail] Subject: Your sign-in code: 123456`) into the `mfaCode` variable.
3. Send step 2.

This happens seven times in the full collection.

### Run it

- **In Postman:** right-click the collection, choose **Run collection**, then **Run**. Expect **0 failed** tests.
- **From the command line:** this is the same as CI, and is what was used to verify the collection:

```bash
npx newman run postman/E-Learning.postman_collection.json \
  -e postman/E-Learning.local.postman_environment.json \
  --env-var superadminEmail=YOU@example.com --env-var superadminPassword=YOUR_PASSWORD \
  --env-var superadminTotpSecret=SUPER_KEY --env-var adminTotpSecret=ADMIN_KEY --env-var teacherTotpSecret=TEACHER_KEY
```

Expected summary: `requests 120 / 0 failed`, `assertions 196 / 0 failed`.

The collection is safe to run repeatedly. Each run creates its own new organisation (then suspends it), student and course (then archives it).

### What each folder demonstrates

| Folder | Role | Shows |
|---|---|---|
| 00 Platform super admin | super admin | Two-step sign-in, overview of every organisation with counts, one organisation's settings and Admins (with member IDs), people filtered to one organisation, creating an organisation with its first Admin, reserved web address refused, suspending, platform-only audit log, organisation Admin refused |
| 01 Public catalogue & sign-up | anonymous → new student | Catalogue, course page, free preview vs locked lesson (EN-02), weak password refused, sign-up is always Student (AD-02), unverified user can't enrol (EN-03), role checks, teacher application (AD-08), wrong password, reset request |
| 02 Teacher builds and submits | teacher | 2FA (AD-07), draft course, empty submit refused (CR-01), details, lessons, quiz and completion rule, submit, teacher can't approve or publish (CR-02), content locked in review |
| 03 Admin rejects with a reason | admin | Review queue, full preview with answer key, rejection needs a reason (CR-03) |
| 04 Teacher resubmits | teacher | Reason visible to the teacher (CR-03), resubmit, bell notification |
| 05 Admin approves and manages | admin | Stats; approve and publish (CR-02); all decisions kept; first Admin can't be demoted or deactivated (AD-04); application decline needs a reason; role change (AD-03); deactivate and reactivate (AD-05); blocked attempts in the audit log (AD-06); audit filters; CSV export |
| 06 Student learns, hits quiz lock | student | Enrol, no duplicate enrolment (EN-01), player, video resume position, progress, answers hidden from learners, 70% pass mark (66.67% fails), 3 failures lock the quiz for 24h (QZ-01/02) |
| 07 Admin resets attempts | admin | Learner list with lock status, reset attempts (QZ-02) |
| 08 Student completes | student | No certificate until every required item is done (CC-01), one certificate with a unique code (CC-02), dashboard, public verification, PDF |
| 09 Admin revokes | admin | Revoke needs a reason (CC-03), delete refused for an enrolled course and archive instead (CR-05), verification shows Revoked, PDF returns 410 |
| 10 Isolation between organisations | student | An acme session is signed out at globex; globex never lists or opens acme courses; an acme certificate is not found via globex; unknown organisation → 404 |

### API shape, for reference

Every call except the GET routes is `POST /api/t/<organisation>/<endpoint>` with a JSON body `{ "action": "...", "data": { ... } }`. The super admin uses `POST /api/platform`.

Each organisation has 8 endpoints: `auth`, `account`, `courses`, `learn`, `admin`, plus `upload` (multipart), `GET files/:id` and `GET certificates/:code`. The session is an httpOnly cookie, which Postman stores automatically. README.md lists every action.

---

## 3. Frontend walkthrough

Use two browsers, or one normal and one private window, so you can be two people at once. While running locally, every email appears in the **API terminal**: verification links, reset links and 2FA codes.

Use **http://localhost:5173/t/acme** for sections A–D. Demo accounts there: `admin@acme.example.com`, `teacher@example.com` and `student@example.com`, all with password `Password123`. Section E covers organisations and the super admin.

### A. New visitor and student

| # | Do this | Expect |
|---|---|---|
| A1 | Open http://localhost:5173 | Catalogue with the demo course. Search, category and level filters work. |
| A2 | Open the course | Outline, "What you'll learn", teacher profile. "Preview" opens the free lesson in a dialog. |
| A3 | **Create account** as "Learn" | Signed in. A yellow banner asks you to verify your email. |
| A4 | Try **Enrol for free** | Button disabled, with "Verify your email to enrol" (EN-03) |
| A5 | Open the verification link from the API terminal | "Your email is verified". The banner disappears. |
| A6 | Enrol | The course player opens. Lessons on the left, highlighter progress bar at the top. |
| A7 | Play the video, pause at ~5 s, go back to **My learning**, then **Resume course** | Resumes at the same lesson and the same video position |
| A8 | **Mark as complete** on lessons | Tick in the sidebar, progress bar moves, jumps to the next item |
| A9 | Take the quiz with wrong answers 3 times | Each result shows a score, which questions were wrong, and attempts left. After the 3rd: "locked", with a countdown (QZ-02). |
| A10 | (Admin or Teacher resets attempts, see C6 or D9) Retake the quiz and pass | "Passed" |
| A11 | Finish every required item | Green banner with the certificate code, **Download PDF**, verification page |
| A12 | Open **Verify a certificate** (top menu) and paste the code | Shows "Valid certificate" with your name and the course |
| A13 | **Profile**: change name, phone, photo; change password | Saved. The certificate uses the profile name. Other sessions are signed out after a password change. |
| A14 | Sign out, then **Forgot your password?** | The reset link in the terminal works once only |
| A15 | Shrink the browser to phone width | Menu collapses. The player's "Contents" button opens the lesson list as a drawer. |

### B. Becoming a teacher (AD-08)

| # | Do this | Expect |
|---|---|---|
| B1 | Sign up and choose **Teach**, filling in expertise and profile | Account is still a Student. **Teach** page shows "Your application is being reviewed". |
| B2 | Admin → **Teacher applications** → **Decline** without a reason | Not allowed; a reason is required |
| B3 | Admin approves | The applicant is signed out, gets a notification and an email, and next sign-in asks for a 2FA code (AD-07) |

### C. Teacher

Sign in as `teacher@example.com`; the 2FA code is in the terminal.

| # | Do this | Expect |
|---|---|---|
| C1 | **Teach** → type a title → **Create draft** | Course editor opens on "Lessons & quizzes" |
| C2 | **Review** tab | Checklist of what's missing: outline, lesson, quiz, completion rule (CR-01). Submit disabled. |
| C3 | **Details**: summary, category, outline, thumbnail upload → Save | Saved |
| C4 | **Lessons & quizzes**: add a section, a text lesson, a video (link or upload), a file lesson (PDF), and a quiz with single, multi-select and true/false questions. Tick **Required** on the items. **Save content**. | "All changes saved". Review checklist turns green. |
| C5 | **Submit for review** | Status "In review". Content becomes read-only. |
| C6 | After the Admin rejects (D3) | Notification, email, and the reason shown on the Review tab. Edit and **Resubmit**. |
| C7 | After approval: **Publish** | Status Published. Course appears in the catalogue. |
| C8 | Edit **Details** (fix a typo) | Saved and live straight away |
| C9 | **Start a revision**, change a lesson, Save, Submit | Course stays Published with "Revision in review". Learners still see the old lesson until the Admin approves (CR-04). |
| C10 | **Learners** tab | Each learner's progress and quiz attempts. **Reset attempts** for a locked learner (QZ-02). |
| C11 | **Unpublish** | Gone from the catalogue. Enrolled learners still open it (CR-05). |
| C12 | **Archive**. Try **Delete** on a course with history or learners. | Delete isn't offered. Only drafts with no history can be deleted (CR-05). |

### D. Admin

Sign in with the `.env` Admin; 2FA is required.

| # | Do this | Expect |
|---|---|---|
| D1 | **Admin** overview | Counts of users by role, enrolments, completions, certificates, courses awaiting review, pending applications, 14-day chart |
| D2 | **Course reviews** → open a course | Full preview including the quiz answer key. Revisions mark items as New or Changed against the live version. |
| D3 | **Reject with a reason** | The reason is required and the teacher sees it. History keeps every reason (CR-03). |
| D4 | **Approve** | Teacher is notified; a revision goes live immediately |
| D5 | **Users**: search, filter, change a student to Teacher | Role changes; the user is signed out (AD-03) |
| D6 | Make a second Admin, then sign in as them and try to change the first Admin | The role selector isn't offered. If forced via the API: refused and logged (AD-04, AD-06). |
| D7 | **Deactivate** a student with a reason | They are signed out and can't sign in. **Reactivate** restores them. Nothing is deleted (AD-05). |
| D8 | **Certificates**: search, then **Revoke** with a reason | Public verification shows "Revoked" with the reason. The PDF no longer downloads (CC-03). |
| D9 | **All courses** → a course → **Learners** → **Reset attempts** | Learner gets 3 new attempts |
| D10 | **Audit log**: filter by actor, action and date; **Export CSV** | Logins, failed logins, blocked attempts, role changes, course decisions, certificate events, each with old/new values and IP |
| D11 | Notification bell | Unread count, newest first, click to open, "Mark all read" |

---

### E. Organisations and the super admin

| # | Do this | Expect |
|---|---|---|
| E1 | Open **http://localhost:5173/** and type `acme` | Taken to Acme Academy. An unknown name says no organisation uses it. Organisations are never listed publicly. |
| E2 | Open `/t/acme` and `/t/globex` side by side | Each shows only its own name, colour, courses and footer |
| E3 | Sign in at `/t/acme` as `student@example.com`, then open `/t/globex/dashboard` in the same browser | Globex asks you to sign in: the Acme session means nothing there |
| E4 | Sign in at `/t/globex` as `student@example.com` (same email, same password) | A different account, with a `GLOBEX-…` member ID on **Profile** instead of `ACME-…` |
| E5 | On `/t/globex`, look for **Create account** | Hidden: Globex is invite-only. The sign-in page says to ask for an invitation. |
| E6 | Globex Admin → **Users** → **Invite someone** | Invitation printed in the API terminal. The link opens "Join Globex Learning"; after setting a password the person can sign in. |
| E7 | Acme Admin → **Settings**: set pass mark 60%, attempts 1, accent colour, allowed domain `acme.com`; Save | Colour changes at once. Quizzes in Acme only now pass at 60% and lock after 1 attempt. Sign-up with a non-`@acme.com` email is refused. Globex is unchanged. |
| E8 | Acme Admin → **Users** | Every row has a member ID; search finds people by member ID |
| E9 | Open **/platform**, sign in as the super admin (code in the API terminal) | Overview with every organisation and its numbers |
| E10 | **Add an organisation**: name, web address, first Admin | Created. The first Admin gets an invitation and appears as "First admin" with member ID `…-000001`. |
| E11 | Open an organisation → **Open its Admin area** | Its Admin pages, with a dashed **Platform console** chip in the bar. Changes are audited as `superadmin`. Demoting its first Admin is still refused (AD-04). |
| E12 | **Suspend** an organisation, then visit its site | "This organisation is suspended" for everyone except the super admin. Other organisations are unaffected. **Reactivate** restores it. |
| E13 | Console → **Audit log**: filter by organisation, or "Platform events only"; **Export CSV** | Entries of that organisation only, or only platform events (super admin sign-ins, organisations created or suspended) |

## 4. Rule coverage matrix

| Rule | Automated test | Postman folder | Walkthrough |
|---|---|---|---|
| AD-01 first Admin by seed | DB trigger + seed (helpers) | 05 (`isRoot`) | Setup |
| AD-02 public sign-up | Authentication › register | 01 | A3 |
| AD-03 Admin changes roles | AD-04 test (promote) | 05 | D5 |
| AD-04 Admin protection | AD-04 test (app + DB) | 05 | D6 |
| AD-05 deactivate, never delete | AD-05 test | 05 | D7 |
| AD-06 logged, immutable | AD-04 test + Audit log test | 05 | D10 |
| AD-07 2FA for Admin/Teacher | AD-07 test + TOTP test | 02–09 | B3, C, D |
| AD-08 Teacher via application/role change | AD-08 tests | 01, 05 | B1–B3 |
| CR-01 submission requirements | CR-01 test | 02 | C2 |
| CR-02 Admin approves; approved → publish | CR-02/03 test | 02, 05 | C7, D4 |
| CR-03 reasons kept, resubmit | CR-02/03 test | 03, 04, 05 | C6, D3 |
| CR-04 re-approval, live stays | CR-04 test | — (needs a published course) | C8, C9 |
| CR-05 unpublish/archive, no delete | CR-05 test | 09 | C11, C12 |
| EN-01 one active enrolment | EN-01 test (app + DB) | 06 | — |
| EN-02 enrolled only | EN-02 test + private files test | 01 | A2, A4 |
| EN-03 verified email | EN-03 test | 01 | A4, A5 |
| QZ-01 70%, 3 attempts | grading test | 06 | A9 |
| QZ-02 24h lock, 3 more, reset | lock test | 06, 07, 08 | A9, A10, C10, D9 |
| CC-01 complete on required items | CC-01/02 test | 08 | A11 |
| CC-02 one certificate, unique code | CC-01/02 test | 08 | A11, A12 |
| CC-03 revoke with reason | CC-03 test | 09 | D8 |
| Organisation and member IDs | tenancy: IDs test | 00 | E4, E8, E10 |
| Isolation between organisations | tenancy: isolation tests (API and PostgreSQL) | 10 | E2, E3, E4 |
| Per-organisation settings | tenancy: configuration tests | 00 | E5, E6, E7 |
| Super admin | tenancy: platform tests | 00 | E9–E13 |
| Certificates for Students only | "Certificates are for Students only" tests | — | Sign in as a Teacher: no **My learning**, no **Enrol** button |

---

## 5. Not covered here, and known limits

- **Google sign-in** needs a real `GOOGLE_CLIENT_ID`, so it is tested by hand only (see README.md).
- **Real email delivery** needs SMTP settings. Locally, emails print in the API terminal.
- **Video resume** tracks the exact position for uploaded and direct `.mp4` videos. YouTube and Vimeo embeds start from the saved position, but the position isn't tracked while they play.
- **Payments, refunds and disputes** are Phase 2. Refund-triggered certificate revocation (CC-03, Phase 2) has its hook ready: `revokeCertificateForEnrollment`.

## 6. Start again with fresh data

```powershell
dropdb -U postgres -p 5000 elearning
createdb -U postgres -p 5000 elearning
cd backend
npm run migrate
npm run seed:superadmin
npm run seed:demo
```
