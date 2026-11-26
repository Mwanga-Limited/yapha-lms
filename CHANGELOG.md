# Changelog

All notable changes to Yapha LMS. Format based on [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [Unreleased]
### Added
- Course unlocking. Sections open in order in every course: each opens when every lesson in the one before is complete and every quiz is passed. Optionally a course opens a set number of hours or days after enrolment. Teachers set the delay with the course content (it takes effect on approval); Admins can set it directly (`courses` `setUnlock`, audited as `course.unlock_set`). The server refuses locked lessons and quizzes; the player shows locks and why.


## [0.9.1] - 2026-11-10
### Changed
- Product metadata: package names (`yapha-lms-backend`, `yapha-lms-frontend`), author, licence (proprietary), homepage and repository fields.
- Default sender name and page title now "Yapha LMS"; production URL `https://learn.yapha.com`.

- Renamed infrastructure identifiers (no deployments existed yet): database `yapha_lms` (test: `yapha_lms_test`), app role `yapha_app`, owner role `yapha_owner`, Docker DB user `yapha`, session cookies `yapha_<slug>` / `yapha_platform`. Existing local databases must be recreated.
- Default sender is `no-reply@yapha.com`; Postman files renamed `Yapha-LMS.*`.

### Added
- Test super admin credentials come from `backend/.env` (`TEST_SUPERADMIN_*`, else `SUPERADMIN_*`), with a built-in fallback.
- LICENSE, NOTICE, SECURITY.md, CONTRIBUTING.md and this changelog.
