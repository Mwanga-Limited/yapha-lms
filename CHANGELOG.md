# Changelog

All notable changes to Yapha LMS. Format based on [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [Unreleased]
### Changed
- Course pricing is optional. A course without a price is free and learners enrol straight away ("Enrol for free"), with or without a referral code. A price, when set, must be at least ₦1,000 (Admin price, approval price and the teacher's suggestion). Approving changes to a free course keeps it free.

## [0.9.1] - 2026-11-10
### Changed
- Product metadata: package names (`yapha-lms-backend`, `yapha-lms-frontend`), author, licence (proprietary), homepage and repository fields.
- Default sender name and page title now "Yapha LMS"; production URL `https://learn.yapha.com`.

- Renamed infrastructure identifiers (no deployments existed yet): database `yapha_lms` (test: `yapha_lms_test`), app role `yapha_app`, owner role `yapha_owner`, Docker DB user `yapha`, session cookies `yapha_<slug>` / `yapha_platform`. Existing local databases must be recreated.
- Default sender is `no-reply@yapha.com`; Postman files renamed `Yapha-LMS.*`.

### Added
- Test super admin credentials come from `backend/.env` (`TEST_SUPERADMIN_*`, else `SUPERADMIN_*`), with a built-in fallback.
- LICENSE, NOTICE, SECURITY.md, CONTRIBUTING.md and this changelog.
