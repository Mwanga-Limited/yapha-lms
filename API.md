# API reference and how to test each endpoint in Postman

Base URL (local): **`http://localhost:4000`**

**Multitenant:** every organisation has the same 8 endpoints under **`/api/t/<organisation>/`**. The examples use the demo organisation `acme`; for another organisation, replace `acme` with its web address (e.g. `globex`). The platform super admin has one more endpoint, `POST /api/platform` (section 9).

The 8 organisation endpoints (plus a health check). Five of them take an **action**:

| # | Endpoint | Method | Who can call it | What it covers |
|---|---|---|---|---|
| 1 | `/api/t/acme/auth` | POST | anyone | sign-up, sign-in, 2FA, Google, sign-out, email verification, password reset |
| 2 | `/api/t/acme/account` | POST | signed in | profile, password, authenticator app, notifications, teacher application, learner dashboard |
| 3 | `/api/t/acme/courses` | POST | anyone / Teacher / Admin | catalogue, course page, preview; course authoring and publishing; learners; quiz resets |
| 4 | `/api/t/acme/learn` | POST | Students only | enrol, course player, lessons, progress, video position, quizzes |
| 5 | `/api/t/acme/admin` | POST | Admin | dashboard, course reviews, teacher applications, users, certificates, audit log |
| 6 | `/api/t/acme/upload` | POST (form-data) | signed in | upload photos, thumbnails, lesson files and videos |
| 7 | `/api/t/acme/files/:id` | GET | public / signed link | download an uploaded file |
| 8 | `/api/t/acme/certificates/:code` | GET | anyone | verify a certificate; `?format=pdf` downloads it |
| 9 | `/api/platform` | POST | platform super admin | organisations, cross-organisation people and audit log, super admin sign-in |
| – | `/api/health` | GET | anyone | is the API running (and the database answering) |

---

## How to send a request in Postman

For the five action endpoints (1–5), every request looks the same:

1. Set the method to **POST** and the URL to, for example, `http://localhost:4000/api/t/acme/auth`.
2. On the **Headers** tab, add `Content-Type: application/json`. Postman adds this itself when you pick JSON in step 4.
3. On the **Body** tab, choose **raw**.
4. In the dropdown on the right, choose **JSON**.
5. Type the body: an `action` name, plus the `data` it needs.

```json
{ "action": "login", "data": { "email": "student@example.com", "password": "Password123!" } }
```

**Staying signed in:** the API returns an `el_session` cookie, which Postman stores and sends automatically. So sign in once, and every later request in Postman runs as that user. To switch user, call `logout`, then sign in as someone else. You can see the cookie under **Cookies** (below the Send button).

**Admin and Teacher sign-in has two steps** (2FA):

1. Send `login`. The response has `mfa.token` but no user yet.
2. Copy the 6-digit code from the backend terminal, which shows a line like `[mail] Subject: Your sign-in code: 482913`. If you've set up an authenticator app, use the code from the app instead.
3. Send `verifyMfa` with the token and the code. You're now signed in.

**Password rules** (for every new password: sign-up, reset, invitation and change): at least 8 characters, with an uppercase letter, a lowercase letter, a number and a special character such as `!`. The 400 error lists whatever is missing. Existing passwords keep working; the rule applies when a password is set.

**Codes you'll see**

| Code | Meaning |
|---|---|
| 200 | It worked |
| 400 | Something in `data` is missing or invalid; the `error` message says what |
| 401 | Not signed in, or wrong password / code |
| 403 | Signed in but not allowed: wrong role, email not verified, not enrolled, or a protected Admin |
| 404 | The course, user or other item doesn't exist |
| 409 | Not allowed in the item's current state, e.g. publishing before approval |
| 422 | The course isn't ready to submit; `problems` lists what's missing |
| 423 | The quiz is locked for 24 hours |
| 429 | Too many attempts; wait 15 minutes |

Errors always come back as `{ "error": "message" }`.

**IDs you need:** many actions need an ID from an earlier response, e.g. `courseId` from `create` or `catalog`, `versionId` from `reviewQueue`, `userId` from `users`. Copy them from the response into the next body. The ready-made Postman collection (`postman/` folder) does this for you automatically.

Demo accounts (after `npm run seed:demo`), all with password `Password123`: in `acme`, `admin@acme.example.com`, `teacher@example.com`, `student@example.com`; in `globex`, `admin@globex.example.com` and the same teacher/student emails, which are **separate accounts**. Super admin: `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` from `backend\.env`.

---

## 1. `/api/t/acme/auth`: sign-up and sign-in

| Action | Body `data` | Expect | Also test |
|---|---|---|---|
| `me` | `{}` | 200, `user` (or `null` when signed out) | Call before and after signing in |
| `register` | `{ "name": "Ada Obi", "email": "ada@example.com", "password": "Password123!" }` | 200, `user.role` = `student`, signed in, `emailVerified` false | `"Password123"` (no special character) → 400 saying what's missing. Same email again → 409. |
| `register` (as teacher) | `{ "name": "Ada Obi", "email": "ada2@example.com", "password": "Password123", "joinAs": "teacher", "application": { "bio": "Ten years teaching accounting to traders.", "expertise": "Accounting" } }` | 200, still `student`; a pending application is created (AD-08) | Missing `application` → 400 |
| `login` | `{ "email": "student@example.com", "password": "Password123!" }` | Student: 200 with `user`. Admin/Teacher: 200 with `mfa` only. | Wrong password → 401. Six wrong tries → 429. |
| `verifyMfa` | `{ "token": "<mfa.token from login>", "code": "482913" }` | 200, `user` (signed in) | `"000000"` → 401 |
| `sendMfaEmail` | `{ "token": "<mfa.token>" }` | 200, a new code is printed in the backend terminal | |
| `logout` | `{}` | 200, then `me` returns `null` | |
| `verifyEmail` | `{ "token": "<token from the verify link in the terminal>" }` | 200 | Use the same token twice → 400 |
| `resendVerification` | `{}` (signed in) | 200, a new link in the terminal | |
| `requestPasswordReset` | `{ "email": "student@example.com" }` | 200 (always, even for unknown emails) | |
| `resetPassword` | `{ "token": "<token from the reset link>", "password": "NewPassword456!" }` | 200; old sessions signed out | Same token again → 400 |
| `google` | `{ "credential": "<Google ID token>" }` | 200; needs `GOOGLE_CLIENT_ID` set | Test from the website rather than Postman |

The token for `verifyEmail` / `resetPassword` is the part after `token=` in the link printed in the backend terminal.

## 2. `/api/t/acme/account`: your account (sign in first)

| Action | Body `data` | Expect | Also test |
|---|---|---|---|
| `updateProfile` | `{ "name": "Tunde Bakare", "phone": "+234 801 234 5678", "bio": "" }` | 200, updated `user` | Empty name → 400. Add `"photoFileId": "<id from /api/upload>"` to set a photo. |
| `changePassword` | `{ "currentPassword": "Password123", "newPassword": "Password456!" }` | 200 | Wrong current password → 400 |
| `totpSetup` | `{}` | 200, `secret`, `uri`, `qr` (QR image) | |
| `totpEnable` | `{ "code": "<6 digits from your authenticator app>" }` | 200, `totpEnabled` true | Wrong code → 400 |
| `totpDisable` | `{ "code": "<6 digits from the app>" }` | 200, `totpEnabled` false | |
| `notifications` | `{ "limit": 20 }` | 200, `items` and `unread` count | |
| `markNotificationsRead` | `{}` for all, or `{ "ids": ["<id>"] }` | 200, `unread` becomes 0 | |
| `applyTeacher` | `{ "bio": "I have taught bookkeeping for ten years.", "expertise": "Bookkeeping", "credentialUrl": "" }` | 200, status `pending` | Again while pending → 409. Bio under 20 characters → 400. |
| `myApplications` | `{}` | 200, your applications and their decisions | |
| `dashboard` | `{}` | 200, your courses with progress, resume point and certificate (Students only) | Teacher or Admin → 403 |

## 3. `/api/t/acme/courses`: catalogue and course authoring

**Public (no sign-in needed)**

| Action | Body `data` | Expect | Also test |
|---|---|---|---|
| `catalog` | `{ "q": "", "category": "", "level": "", "page": 1 }` | 200, published `courses`, `total`, `categories` | `"q": "bookkeeping"`, `"level": "beginner"` |
| `detail` | `{ "id": "<courseId>" }` | 200, course, `outline`, `teacher`, `viewer` | Unpublished course while not enrolled → 404 |
| `preview` | `{ "courseId": "<courseId>", "lessonId": "welcome" }` | 200 for a free-preview lesson | A normal lesson (`"video1"`) → 403 (EN-02) |

`lessonId` values come from `detail` → `outline[].items[].id`. In the demo course they are `welcome`, `video1` and `daily`, and the quiz is `check`.

**Teacher (or Admin): sign in with 2FA first**

| Action | Body `data` | Expect | Also test |
|---|---|---|---|
| `mine` | `{}` | 200, your courses with status | Student → 403 |
| `create` | `{ "title": "Algebra Basics" }` | 200, `id` (keep it as `courseId`) | |
| `get` | `{ "id": "<courseId>" }` | 200, details, live and draft content, problems, review history | Another teacher's course → 403 |
| `updateMeta` | see **Body A** below | 200 | While in review → 409 |
| `saveContent` | see **Body B** below | 200, `problems` = `[]` when complete | While in review → 409 |
| `submit` | `{ "id": "<courseId>" }` | 200, status `in_review` | Empty course → 422 with `problems` (CR-01). Unverified email → 403. |
| `publish` | `{ "id": "<courseId>" }` | 200 after Admin approval | Before approval → 409 (CR-02) |
| `unpublish` | `{ "id": "<courseId>" }` | 200; hidden from catalogue, learners keep access (CR-05) | |
| `startRevision` | `{ "id": "<courseId>" }` | 200; creates an editable copy of a published course (CR-04) | |
| `discardRevision` | `{ "id": "<courseId>" }` | 200; throws the copy away | |
| `archive` | `{ "id": "<courseId>" }` | 200 | |
| `remove` | `{ "id": "<courseId>" }` | 200 only for a never-reviewed draft | With enrolments or review history → 409 (CR-05) |
| `learners` | `{ "id": "<courseId>" }` | 200, each learner's progress and quiz attempts | |
| `resetAttempts` | `{ "enrollmentId": "<from learners>", "quizId": "q1" }` | 200; learner gets 3 new attempts (QZ-02) | Student → 403 |

**Body A: `updateMeta`**

```json
{ "action": "updateMeta", "data": {
  "id": "<courseId>", "title": "Algebra Basics", "summary": "Learn algebra step by step",
  "category": "Mathematics", "level": "beginner", "language": "English",
  "outline": "Variables\nEquations\nWord problems",
  "description": "A friendly introduction to algebra."
} }
```

**Body B: `saveContent`**, a complete course with three lesson types, a quiz and a completion rule:

```json
{ "action": "saveContent", "data": { "id": "<courseId>", "content": {
  "sections": [{ "id": "s1", "title": "Getting started", "items": [
    { "id": "l1", "kind": "lesson", "title": "Welcome", "type": "text", "body": "Hello and welcome.", "preview": true },
    { "id": "l2", "kind": "lesson", "title": "Watch this", "type": "video", "videoUrl": "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
    { "id": "q1", "kind": "quiz", "title": "Check-in", "questions": [
      { "id": "a", "type": "single", "prompt": "2 + 2 = ?", "options": [{ "id": "x", "text": "4" }, { "id": "y", "text": "5" }], "correct": ["x"] },
      { "id": "b", "type": "truefalse", "prompt": "The sky is blue", "correct": ["true"] },
      { "id": "c", "type": "multi", "prompt": "Pick the even numbers", "options": [{ "id": "m", "text": "2" }, { "id": "n", "text": "3" }, { "id": "o", "text": "4" }], "correct": ["m", "o"] }
    ] }
  ] }],
  "completion": { "lessons": ["l1", "l2"], "quizzes": ["q1"] }
} } }
```

For a file lesson, upload the file first (endpoint 6, purpose `lesson_file`), then use `{ "id": "f1", "kind": "lesson", "title": "Notes", "type": "file", "fileId": "<file id>" }`.

## 4. `/api/t/acme/learn`: taking a course (Students only)

Only Student accounts can enrol and learn, so only Students earn certificates. A Teacher or Admin calling these actions gets **403** (`enrol` returns code `STUDENTS_ONLY`).

| Action | Body `data` | Expect | Also test |
|---|---|---|---|
| `enrol` | `{ "courseId": "<courseId>" }` | 200, `enrollmentId` | Again → 200 with `alreadyEnrolled: true` (EN-01). Unverified email → 403 (EN-03). |
| `player` | `{ "courseId": "<courseId>" }` | 200, outline with done ticks, `progress`, `resumeItemId`, `certificate` | Not enrolled → 403 `NOT_ENROLLED` (EN-02) |
| `lesson` | `{ "courseId": "<courseId>", "lessonId": "l2" }` | 200, lesson content, `positionSec` | Not enrolled → 403 |
| `savePosition` | `{ "courseId": "<courseId>", "lessonId": "l2", "positionSec": 42.5 }` | 200; next `lesson` call returns `positionSec: 42.5` | |
| `completeLesson` | `{ "courseId": "<courseId>", "lessonId": "l1" }` | 200, new `progress`; `certificate` once everything required is done | |
| `quiz` | `{ "courseId": "<courseId>", "quizId": "q1" }` | 200, questions **without** answers, attempts left | |
| `submitQuiz` | `{ "courseId": "<courseId>", "quizId": "q1", "answers": { "a": ["x"], "b": ["true"], "c": ["m", "o"] } }` | 200, `score` 100, `passed` true | See the quiz test below |

**Quiz test (QZ-01 / QZ-02)**

1. Submit wrong answers `{ "a": ["y"], "b": ["false"], "c": ["n"] }` three times. Each time `passed` is false and `attemptsLeft` goes 2, 1, 0. After the third, `lockedUntil` is about 24 hours away.
2. A fourth submit → **423** `QUIZ_LOCKED`.
3. As the Teacher or Admin, run `courses` → `resetAttempts`. The student gets 3 attempts again.
4. `{ "a": ["x"], "b": ["true"], "c": ["m"] }` scores 66.67%: below the 70% pass mark, because multi-select answers must be exactly right.

## 5. `/api/t/acme/admin`: administration (sign in as Admin with 2FA)

| Action | Body `data` | Expect | Also test |
|---|---|---|---|
| `stats` | `{}` | 200; users, enrolments, completions, courses awaiting review, 14-day chart | Teacher → 403 |
| `reviewQueue` | `{}` | 200; courses waiting, each with `versionId` | |
| `approveCourse` | `{ "versionId": "<from reviewQueue>", "note": "Looks good" }` | 200; course `approved`, or a revision goes live | Already decided → 409 |
| `rejectCourse` | `{ "versionId": "<from reviewQueue>", "reason": "Please add an introduction." }` | 200; teacher sees the reason | Empty reason → 400 (CR-03) |
| `courses` | `{ "q": "", "status": "", "page": 1 }` | 200, all courses in any status | `"status": "published"` |
| `applications` | `{ "status": "pending" }` | 200; also `approved`, `declined`, `all` | |
| `decideApplication` | `{ "id": "<application id>", "decision": "approve" }` | 200; user becomes Teacher | Decline without `reason` → 400 |
| `users` | `{ "q": "ada", "role": "", "status": "", "page": 1 }` | 200, matching users | `"role": "teacher"`, `"status": "inactive"` |
| `changeRole` | `{ "userId": "<id>", "role": "teacher" }` | 200 (AD-03) | On the first Admin or another Admin → 403, and logged (AD-04, AD-06) |
| `setActive` | `{ "userId": "<id>", "active": false, "reason": "Spam account" }` | 200; user signed out and can't sign in (AD-05) | No reason → 400. An Admin → 403. `"active": true` reactivates. |
| `certificates` | `{ "q": "EL-", "page": 1 }` | 200; search by code, name, email or course | |
| `revokeCertificate` | `{ "id": "<certificate id>", "reason": "Academic misconduct" }` | 200 (CC-03) | Empty reason → 400 |
| `audit` | `{ "actor": "", "action": "", "from": "2026-10-01", "to": "2026-10-31", "page": 1 }` | 200; entries with actor, action, target, old/new values, IP, time | `"action": "user.role_change_blocked"` |
| `auditCsv` | same as `audit` | 200; `csv` text and a `filename` | |
| `settings` | `{}` | 200; this organisation's ID, web address, settings and member count | Teacher → 403 |
| `updateSettings` | see **Body C** below | 200; new settings apply immediately to this organisation only | `"passMark": 0` → 400 |
| `inviteUser` | `{ "name": "Bola Ade", "email": "bola@example.com", "role": "student" }` | 200; `user.memberCode`; invitation link printed in the backend terminal | Email already a member → 409. Not an allowed domain → 400 |

The `users` search also matches member IDs, e.g. `{ "q": "ACME-000003" }`.

**Body C: `updateSettings`.** Always send all four groups:

```json
{ "action": "updateSettings", "data": {
  "name": "Acme Academy",
  "settings": {
    "branding": { "displayName": "", "logoFileId": null, "accentColor": "#F2CC3D" },
    "quiz": { "passMark": 70, "maxAttempts": 3, "lockHours": 24 },
    "access": { "signup": "open", "allowedDomains": [] },
    "auth": { "google": true, "studentMfa": false }
  }
} }
```

- `quiz` replaces the fixed 70% / 3 attempts / 24 hours for this organisation.
- `access.signup: "invite"` makes `register` return 403 `INVITE_ONLY`.
- `allowedDomains: ["acme.com"]` only lets `@acme.com` (and its subdomains) join.
- `auth.studentMfa: true` gives Students the same two-step sign-in as Admins.
- `branding.logoFileId` comes from uploading with `purpose: logo`.

**Accepting an invitation:** the invitee opens the link, or in Postman sends `resetPassword` to `/api/t/acme/auth` with the `token` from the link and a new `password`. Their email is marked verified.

## 6. `POST /api/t/acme/upload`: files (sign in first)

In Postman: **POST** `http://localhost:4000/api/t/acme/upload`, **Body** → **form-data**, with two rows:

| Key | Type | Value |
|---|---|---|
| `purpose` | Text | `photo`, `thumbnail`, `lesson_file`, `lesson_video` or `logo` (Admin, PNG/JPG, 2 MB) |
| `file` | **File** (change the type in the key's dropdown) | choose a file |

Remove any `Content-Type` header you added yourself; Postman sets the right one for form-data. Expect 200 with `file.id`, which you pass as `photoFileId` (profile), `thumbnailFileId` (`updateMeta`) or a lesson's `fileId`.

| Purpose | Who | Allowed | Max size |
|---|---|---|---|
| `photo` | anyone signed in | PNG, JPG, WebP, GIF | 5 MB |
| `thumbnail` | Teacher, Admin | PNG, JPG, WebP, GIF | 5 MB |
| `lesson_file` | Teacher, Admin | PDF, PowerPoint, Word, Excel, ZIP, TXT, PNG, JPG | 50 MB |
| `lesson_video` | Teacher, Admin | MP4, WebM, OGG, MOV | 500 MB |

Also test: a student uploading a `lesson_file` → 403; an `.exe` → 400.

## 7. `GET /api/t/acme/files/:id`: download a file

- **Photos and thumbnails** are public: `GET http://localhost:4000/api/t/acme/files/<file id>` → 200.
- **Lesson files and videos** are private. Without a valid link → **403**. The working link comes from `learn` → `lesson` (`lesson.fileUrl`), and only for an enrolled learner. It looks like `/api/files/<id>?exp=...&sig=...` and expires after 4 hours. Add `&download` to save the file instead of opening it.

## 8. `GET /api/t/acme/certificates/:code`: verify a certificate (public)

| Request | Expect |
|---|---|
| `GET http://localhost:4000/api/t/acme/certificates/EL-ABCD-2345-WXYZ` | 200; `valid` true or false, name, course, teacher, dates; revoke reason if revoked |
| same with `?format=pdf` | 200, the PDF. In Postman, choose **Send and Download** to save it. |
| a revoked certificate with `?format=pdf` | 410 |
| an unknown code | 404 |

The certificate code comes from `completeLesson` / `submitQuiz` (`certificate.code`) or from `account` → `dashboard`.

## 9. `POST /api/platform`: platform super admin

Same `{ "action", "data" }` shape, at `http://localhost:4000/api/platform`. Only super admins (created by `npm run seed:superadmin`) can sign in here; organisation accounts can't, even with the same email. Sign-in is always two steps.

| Action | Body `data` | Expect | Also test |
|---|---|---|---|
| `login` | `{ "email": "<SUPERADMIN_EMAIL>", "password": "<SUPERADMIN_PASSWORD>" }` | 200 with `mfa` | An organisation Admin's email → 401 |
| `verifyMfa` | `{ "token": "<mfa.token>", "code": "123456" }` | 200, `user.role` = `superadmin` | |
| `stats` | `{}` | 200; totals plus one row per organisation (members, courses, enrolments, certificates, last activity) | Signed out → 401 |
| `tenants` | `{ "q": "", "status": "" }` | 200; organisations with counts | `"status": "suspended"` |
| `tenant` | `{ "id": "<organisation id>" }` | 200; settings, Admins (with member IDs), recent activity | |
| `createTenant` | `{ "name": "Delta School", "slug": "delta", "adminName": "Dami", "adminEmail": "dami@delta.example.com" }` | 200; new organisation at `/t/delta`; its first Admin is invited by email | Slug taken → 409. Reserved (`platform`, `api`, `admin`…) → 400 |
| `updateTenant` | `{ "id": "<id>", "status": "suspended" }` (or `name`, `settings` like Body C) | 200 | Members of a suspended organisation get 403 `TENANT_SUSPENDED` |
| `addTenantAdmin` | `{ "tenantId": "<id>", "name": "...", "email": "..." }` | 200; invitation sent | |
| `users` | `{ "q": "", "tenantId": "", "role": "", "page": 1 }` | 200; people in every organisation, each with its organisation | `"tenantId": "<id>"` for one organisation |
| `audit` / `auditCsv` | `{ "tenantId": "", "actor": "", "action": "", "from": "", "to": "", "page": 1 }` | 200; every organisation's log plus platform events | `"tenantId": "platform"` for platform events only |
| `changePassword`, `totpSetup`, `totpEnable`, `sendMfaEmail`, `logout`, `me` | as in `/auth` and `/account` | | |

**Inside an organisation:** a signed-in super admin can also call that organisation's `/admin` and `/courses` actions, acting as its Admin. Those calls are audited as `superadmin`, and AD-04 still applies. They have no personal account there, so `/account` returns 403.

**Isolation checks to try:**
- Sign in to `acme` as a student, then call `/api/t/globex/account` `dashboard` → 401: the session belongs to acme only.
- `/api/t/globex/courses` `detail` with an acme course ID → 404.
- `GET /api/t/globex/certificates/<acme code>` → 404.

## Health check

`GET http://localhost:4000/api/health` → `{ "ok": true }`

---

## A full run in the right order

To show the whole flow by hand, send these in order. Steps 2–5 build the course, so use your new `courseId` from step 2 onwards.

1. **Student, signed out:** `courses/catalog` → `courses/detail` → `courses/preview`
2. **Teacher** (`auth/login` + `auth/verifyMfa`): `courses/create` → `courses/submit` (expect 422) → `courses/updateMeta` → `courses/saveContent` → `courses/submit` → `auth/logout`
3. **Admin:** `admin/reviewQueue` → `admin/rejectCourse` → `auth/logout`
4. **Teacher:** `courses/get` (see the reason) → `courses/submit` → `auth/logout`
5. **Admin:** `admin/reviewQueue` → `admin/approveCourse` → `courses/publish` → `admin/users` → `admin/changeRole` → `admin/audit` → `auth/logout`
6. **Student** (`auth/login`): `learn/enrol` → `learn/player` → `learn/completeLesson` (l1, l2) → `learn/submitQuiz` (correct answers) → `account/dashboard` → `auth/logout`
7. **Anyone:** `GET /api/t/acme/certificates/<code>` and `?format=pdf`
8. **Admin:** `admin/certificates` → `admin/revokeCertificate` → verify the certificate again (now `valid: false`)

The Postman collection in `postman/` is this same flow, with 101 requests that check every result automatically. Import it and choose **Run collection** (see TESTING.md).
