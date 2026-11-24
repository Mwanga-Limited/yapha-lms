# Google Cloud runbook

For the Cloud Run deployment defined in `deploy/gcp/terraform`. **Status: written and reviewed, but not run against a real Google Cloud project** (no project was available while building it). Do the first deployment in a throwaway project, read `terraform plan` before every apply, and treat anything below marked *verify* as unproven.

## 1. What runs where

| Part | Google service | Notes |
|---|---|---|
| App (API + built frontend) | Cloud Run service `yapha` | Stateless. 1–N instances. Port 8080 |
| Database | Neon PostgreSQL (managed outside Google Cloud), point-in-time restore | App uses the pooled URL; migrations and backups use the direct (unpooled) URL |
| Uploads | Cloud Storage `<project>-yapha-uploads` | Versioned, 7-day soft delete, public access prevented. Browsers upload directly with signed addresses |
| Independent backups | Cloud Storage `<project>-yapha-backups` (second region, retention policy) | Nightly SQL dump + copy of every uploaded file |
| Email | Your SMTP provider | Queue (outbox table) + retries; worker called every minute by Cloud Scheduler |
| Secrets | Secret Manager | DB URLs, JWT secret, TOTP and data encryption keys, metrics token, SMTP password (defined in `terraform/secrets.tf`) |
| Deploys | GitHub Actions → Artifact Registry → Cloud Run | Keyless (Workload Identity Federation), `production` environment |
| Alerts | Cloud Monitoring | Email channel; table in section 6 |

## 2. First-time setup

1. Create a project with billing. Create a bucket for Terraform state by hand (versioning on).
2. `cd deploy/gcp/terraform`, copy `terraform.tfvars.example` to `terraform.tfvars`, fill it in. `export TF_VAR_smtp_password=…`.
3. Build and push a first image (or apply once with any public image to create the registry, then push yours): `gcloud auth configure-docker REGION-docker.pkg.dev`, `docker build -t REGION-docker.pkg.dev/PROJECT/yapha/app:first .`, `docker push …`. Put that tag in `image`.
4. `terraform init -backend-config="bucket=<state bucket>"`, `terraform plan`, read it, `terraform apply`.
5. Run migrations: `gcloud run jobs execute yapha-migrate --region REGION --wait`.
6. Create the platform super admin (once): `gcloud run jobs execute yapha-migrate --region REGION --args=…` is **not** suitable (it runs migrations); instead create a one-off job from the same image with command `node src/scripts/seed-superadmin.js` and env `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` (12+ characters), then delete that job.
7. DNS: add the records printed by `terraform output dns_records`. Set the GitHub repository variables from `terraform output` (`GCP_PROJECT`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOYER_SA`), create the `production` environment with required reviewers, and run `deploy/github/apply-ruleset.sh owner/repo` (branch protection).
8. After backups have worked for a while and you are sure of the period, set `lock_backup_retention = true`. **This is permanent.**

### Email must be set up properly, or invitations and sign-in codes land in spam
Publish SPF, DKIM and DMARC for the domain in `MAIL_FROM` exactly as your SMTP provider instructs. Start DMARC at `p=none` with a `rua=` address, read the reports for a week, then move to `quarantine`. Send a test invitation to Gmail and Outlook and look at "show original" for `spf=pass dkim=pass dmarc=pass`.

### Moving existing disk uploads into the bucket
`UPLOAD_DIR=./uploads GCS_BUCKET=<bucket> DATABASE_URL=… npm run files:to-gcs` (safe to repeat). Run before switching `STORAGE_DRIVER` to `gcs`.

### Existing authenticator secrets
Every deployment's migrate job also runs `encrypt-totp-secrets`, which encrypts any plain-text secret. Key rotation: set `TOTP_ENCRYPTION_KEY_PREVIOUS` to the old key and `TOTP_ENCRYPTION_KEY` to a new one, deploy, run the script, then remove the old key.

## 3. Deploying
Merge to `main` → CI → the `Deploy` workflow builds, pushes, runs the migrate job, updates the backup job, deploys the revision and checks `/api/health`. Migrations only go forward: **take a manual backup first** if a release contains a migration (`gcloud run jobs execute yapha-backup --region REGION --wait`).
Rollback with no new migration: `gcloud run services update-traffic yapha --to-revisions=<previous>=100`. Rollback past a migration: restore (section 5).

## 4. Scale and connections
Total database connections = `db_pool_max` × running instances (+ jobs). Defaults: 10 × 4 = 40 of `max_connections` 100. If you raise `max_instances`, raise the database tier and `db_max_connections` first; the alert "Database under pressure" fires at 80%. If the site is behind your own load balancer instead of the direct Cloud Run address, set `TRUST_PROXY=2`, otherwise per-address rate limits would see the load balancer.

## 5. Backups and restore
- **First line:** Neon's point-in-time restore. Restore into a new Neon branch from the console, never over production.
- **Independent copy:** the nightly job writes `db/<timestamp>/database.sql.gz` and `manifest.json`, and copies every upload to `files/…` in the backup bucket. `latest.json` points at the newest.
- **Restore drill (do this quarterly, and once before launch):**
  1. Create a scratch Neon branch (or a local Postgres), run `npm run migrate` against it.
  2. `BACKUP_BUCKET=… SCRATCH_DATABASE_URL=postgres://… ./deploy/gcp/restore-drill.sh`
  3. It restores the newest backup, compares tenant/user/file counts with the manifest, and checks every file the database references exists in the backup. It must print `RESTORE DRILL PASSED`.
  4. Log the date, the backup used and how long it took. Delete the scratch database.
- RPO: up to a few minutes with PITR, 24 h for the independent copy. RTO: plan for an hour or more; the drill tells you the real number.

## 6. Alerts and what to do
| Alert | Meaning | First step |
|---|---|---|
| Site is down | Health check failing 3 min | Cloud Run logs; `/api/health` names the failing check (database, migrations). Check Neon status (status.neon.com) and that the project is not suspended |
| Too many server errors | >5 5xx/min for 5 min | Logs `severity=ERROR`; each carries `requestId`. Roll back the revision if it started with a deploy |
| No successful backup in 26 h / Backup job failed | Backup job | Cloud Run → Jobs → `yapha-backup` → executions → logs. Run it by hand |
| Emails are not going out | Outbox lag > 10 min or worker silent | Scheduler job `yapha-outbox-drain`; SMTP credentials and provider status. Mail waits in `email_outbox` and is retried (1, 5, 30, 120, 720 min); sign-in codes expire after 10 min |
| An email failed permanently | >3/hour refused for good | Bad addresses, or the sender is blocked: check SPF/DKIM/DMARC and the provider |
| Database under pressure | Disk, CPU or connections >80% | Check slow queries (Query Insights); lower `max_instances` or raise the tier |

## 7. Locked-out people
- A user lost their phone and recovery codes: an Admin uses **Users → Reset 2FA** (Admins' 2FA is reset by the platform super admin).
- The platform super admin lost both: with database access, `SUPERADMIN_EMAIL=… node src/scripts/reset-superadmin-2fa.js` (run as a one-off job). It is audited.

## 8. Not exercised
Everything under `deploy/gcp/`, the GitHub deploy workflow, the Docker build and the CI container smoke test (the build machine had no Docker, no Terraform run and no Google Cloud access). The application code behind them is covered by tests: outbox and retries, TOTP and recovery codes, invitation limits, direct uploads against an in-memory bucket, the Postgres rate-limit store and the scheduler endpoints.
