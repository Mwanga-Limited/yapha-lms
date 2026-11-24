# Deploy to a new Google Cloud account and go to production

A step-by-step guide, from an empty Google Cloud account to a live, monitored, backed-up site.
Reference material (alerts, restore, lockouts) is in `RUNBOOK.md` next to this file; this guide is the order to do things in.

> **Read this first.** The Terraform, the deploy workflow and the Docker image in this repository were written and reviewed but **never run against a real Google Cloud project** (the machine they were written on had no Google Cloud access, no Docker and no working Terraform). Do the whole guide once in a **throwaway project** first (Part A–D). Expect to fix small things. Only then repeat it for production, or promote the throwaway project after Part F.

Time needed: about half a day for the first run (the domain certificate can take up to an hour). Most steps are copy-paste.

---

## Part A. Before you start

### A1. What you need
| Need | Why |
|---|---|
| A Google account that can create projects, with a **billing account** | Everything below costs money (see A3) |
| A **domain** you control (e.g. `learn.example.com`) | The site's address and the sender domain for email |
| An **SMTP email provider** (Postmark, SendGrid, Mailgun, Amazon SES, …) | Sign-in codes, invitations, verification. Google Cloud blocks outbound port 25, so use port 587 or 465 |
| A **GitHub repository** with this code | Automatic deploys |
| On your computer: `gcloud`, `terraform` 1.7+, `docker`, `git`, `node` 20+ | Setup commands |
| Someone to receive alerts | An email address that is read |

### A2. Decide these now (you will type them several times)
```
PROJECT_ID   = yapha-prod-123456          # globally unique, lowercase, cannot change
REGION       = europe-west1               # where the app and database run: pick one near your users
BACKUP_REGION= europe-west4               # MUST differ from REGION (a regional outage must not take the backups too)
DOMAIN       = learn.example.com
APP_URL      = https://learn.example.com  # no trailing slash
GITHUB_REPO  = your-org/yapha-lms
ALERT_EMAIL  = oncall@example.com
```

### A3. What it will cost (order of magnitude, check the calculator for your region)
The database is **Neon** (billed by Neon, not Google; see neon.com/pricing). The main Google costs are the **always-on Cloud Run instance** (`min_instance_count = 1`, CPU always allocated), storage and egress (grows with videos), and the SMTP provider. To save money in a trial: set `min_instance_count = 0` and delete the project when you finish. Never lower these for real production without deciding it on purpose.

**Set a budget alert now:** Billing → Budgets & alerts → create a budget with email alerts at 50%, 90% and 100%. 

---

## Part B. Prepare the Google Cloud project

### B1. Sign in and create the project
```bash
gcloud auth login
gcloud auth application-default login          # Terraform uses this identity
gcloud projects create PROJECT_ID --name="Yapha LMS"
gcloud billing accounts list                    # copy the ACCOUNT_ID
gcloud billing projects link PROJECT_ID --billing-account=ACCOUNT_ID
gcloud config set project PROJECT_ID
```
If you use a Google Workspace organisation, create the project inside it (`--organization=ORG_ID`) and use a Cloud Identity group, not a personal account, for owners.

### B2. Check organisation policies (Workspace/organisation accounts only)
The site must be reachable by the public (`allUsers` can invoke the Cloud Run service). If your organisation has the policy **Domain restricted sharing** (`iam.allowedPolicyMemberDomains`), the apply will fail at `google_cloud_run_v2_service_iam_member.public`. Ask your organisation admin for an exception on this project. A brand-new personal account has no such policy.

### B3. Create the Terraform state bucket (by hand, once)
Terraform stores what it built in a bucket. It must exist before Terraform runs, so it cannot be created by Terraform.
```bash
gcloud storage buckets create gs://PROJECT_ID-tfstate --location=REGION --uniform-bucket-level-access
gcloud storage buckets update gs://PROJECT_ID-tfstate --versioning
```

### B4. Verify your domain (needed for the custom address)
Cloud Run only maps a domain you have proven you own.
```bash
gcloud domains verify DOMAIN          # opens Search Console: add the TXT record it shows at your DNS provider
```
Verify the **parent** domain (`example.com`) with the same Google account that runs Terraform. Wait until Search Console shows it as verified.

### B5. Set up email sending (do this early: DNS changes take time)
1. In your SMTP provider, add and verify your sending domain (the domain in `MAIL_FROM`).
2. The provider gives you DNS records. Add them at your DNS host:
   - **SPF** (TXT) and **DKIM** (TXT or CNAME): exactly as the provider shows.
   - **DMARC** (TXT at `_dmarc.example.com`): start with `v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com`.
3. Note the provider's **SMTP host, port (587), username and password**.
Without SPF/DKIM/DMARC, invitations and sign-in codes will land in spam and people will be locked out. Do not skip this.

### B7. Create the database on Neon (before Terraform: it needs these two strings)
1. Sign up at neon.com, create a project. Pick the Neon region **closest to your Google Cloud REGION** (the app talks to the database on every request).
2. Use PostgreSQL 18 and keep the default role (it owns the database and can create roles, which the migration needs).
3. In the Neon console → Connect, copy two connection strings: the **pooled** one (host contains `-pooler`) and the **direct** one (same, without `-pooler`). Both must end in `?sslmode=verify-full`.
4. Put them in your shell (never in a file):
```bash
export TF_VAR_database_url='postgresql://...-pooler.../neondb?sslmode=verify-full'
export TF_VAR_database_url_unpooled='postgresql://.../neondb?sslmode=verify-full'
```
Export these (and `TF_VAR_smtp_password`) again in every new terminal before running `terraform`.

### B6. (Optional) Google sign-in
Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → *Web application*. Add `APP_URL` under **Authorized JavaScript origins**. Copy the client ID; you will put it in `terraform.tfvars` as `google_client_id`. (You may need to configure the OAuth consent screen first.)

---

## Part C. Create the infrastructure

The order below matters. The Cloud Run service reports unhealthy until the database has been migrated, so creating everything in one go would fail. We create the base first, migrate, then create the rest.

### C1. Configure Terraform
```bash
cd deploy/gcp/terraform
cp terraform.tfvars.example terraform.tfvars
```
Edit `terraform.tfvars`: `project_id`, `region`, `backup_region`, `app_url`, `domain`, `alert_email`, `github_repo`, `mail_from`, `smtp_host`, `smtp_user`, and `google_client_id` if used. Leave `image` for now (placeholder). Put the SMTP password in your shell, never in a file:
```bash
export TF_VAR_smtp_password='the-smtp-password'
terraform init -backend-config="bucket=PROJECT_ID-tfstate"
terraform validate
```
`terraform validate` must print "Success". Fix anything it reports before going on.

### C2. Create the APIs and the image registry
```bash
terraform apply \
  -target=google_project_service.apis \
  -target=google_artifact_registry_repository.images
```
Read the plan, type `yes`.

### C3. Build and push the first image
From the repository root:
```bash
gcloud auth configure-docker us-east4-docker.pkg.dev
IMAGE=us-east4-docker.pkg.dev/yapha-lms-514514/yapha/app:first
docker build -t $IMAGE .
docker push $IMAGE
```
Edit `terraform.tfvars` and set `image = "<the IMAGE value above>"`.

### C4. Create the secrets, storage and the migrate job
```bash
cd deploy/gcp/terraform
terraform apply -target=google_cloud_run_v2_job.migrate -target=google_cloud_run_v2_job.backup
```
This also creates what they depend on: the secrets (the Neon connection strings from B7, plus `JWT_SECRET`, `TOTP_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY` and the metrics token, which Terraform generates in `secrets.tf`; all are stored in Secret Manager), both buckets and the service accounts. Read the plan; it should create dozens of resources and **not** destroy anything.

### C5. Run the database migrations
```bash
gcloud run jobs execute yapha-migrate --region REGION --wait
```
It must finish with `Execution ... has successfully completed`. If it fails, read the logs (the command prints a link; or Cloud Run → Jobs → `yapha-migrate` → Logs). Common causes: the image wasn't pushed, or the database user can't switch to the `yapha_app` role (the migrate script says so in plain words).

### C6. Create everything else
```bash
terraform apply
```
Creates the Cloud Run service, the public access rule, the domain mapping, the scheduler jobs, GitHub deploy access and all alerts. Read the plan, `yes`. At the end Terraform prints outputs; keep them:
```bash
terraform output
```

### C7. Point your domain at it
`terraform output dns_records` lists DNS records (usually a CNAME to `ghs.googlehosted.com`, or A/AAAA records for an apex domain). Add them at your DNS host. Google then issues the HTTPS certificate automatically, which can take **up to an hour**. Check:
```bash
gcloud beta run domain-mappings describe --domain=DOMAIN --region=REGION
```
until the certificate condition reads `Ready`. Meanwhile the app also answers at the `*.run.app` address from `terraform output service_url`.

---

## Part D. First launch: create the first accounts

### D1. Check it is alive
```bash
curl -s https://DOMAIN/api/health
# {"ok":true,"checks":{"database":true,"migrations":true,"storage":true}}
```
A 503 names the failing check. If `database` fails: the Neon URL in the `yapha-database-url` secret (use the pooled `-pooler` host), or Neon is suspended/unreachable. If `migrations` fails: step C5 didn't finish.

### D2. Create the platform super admin (once)
There is no ready-made job for this on purpose (it needs a password). Create a temporary job, run it, delete it. The password is visible in the job's configuration while it exists, so delete it straight away.
```bash
SA=yapha-app@PROJECT_ID.iam.gserviceaccount.com
gcloud run jobs deploy yapha-seed --region REGION \
  --image "$IMAGE" --command node --args src/scripts/seed-superadmin.js \
  --service-account "$SA" \
  --set-secrets "DATABASE_URL=yapha-database-url:latest,DATABASE_URL_UNPOOLED=yapha-database-url-unpooled:latest,JWT_SECRET=yapha-jwt-secret:latest,TOTP_ENCRYPTION_KEY=yapha-totp-encryption-key:latest,DATA_ENCRYPTION_KEY=yapha-data-encryption-key:latest,SMTP_PASS=yapha-smtp-pass:latest" \
  --set-env-vars "NODE_ENV=production,APP_URL=APP_URL,MAIL_TRANSPORT=smtp,SMTP_HOST=smtp.resend.com,SMTP_PORT=465,SMTP_SECURE=true,SMTP_USER=resend,MAIL_FROM=you@DOMAIN,STORAGE_DRIVER=gcs,GCS_BUCKET=PROJECT_ID-yapha-uploads,SUPERADMIN_EMAIL=owner@example.com,SUPERADMIN_PASSWORD=A-Long-Unique-Passw0rd!"
gcloud run jobs execute yapha-seed --region REGION --wait
gcloud run jobs delete yapha-seed --region REGION --quiet
```
(Replace the capitalised placeholders. The password needs 12+ characters.)

### D3. Set up the super admin's two-step sign-in
1. Open `https://DOMAIN/platform`, sign in with the email and password. A code arrives **by email** (this proves email delivery works).
2. Go to **Account** → set up an authenticator app → scan the QR code → enter a code.
3. **Save the 10 recovery codes** somewhere safe (a password manager), not in email. They are shown once.

### D4. Create the first organisation
Open `https://DOMAIN/register` and register an organisation (the person registering becomes its first Admin). Verify the email, sign in (code by email), and set up that Admin's authenticator app too. Try inviting a real person and check the invitation arrives in the inbox (not spam).

### D5. Test a file upload
As the Admin: Settings → Branding → upload a logo. Then, as a teacher, upload a lesson file. This exercises the direct-to-bucket upload; if it fails with a network error in the browser console, the bucket's CORS setting doesn't match `app_url` exactly (scheme, host, no trailing slash).

---

## Part E. Turn on automatic deploys

### E1. GitHub repository variables
Repository → Settings → Secrets and variables → Actions → **Variables** (not secrets; nothing here is secret):
| Variable | Value |
|---|---|
| `GCP_PROJECT` | `PROJECT_ID` |
| `GCP_REGION` | `REGION` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `terraform output -raw github_wif_provider` |
| `GCP_DEPLOYER_SA` | `terraform output -raw github_deployer_sa` |

No keys or passwords are stored in GitHub: GitHub proves its identity to Google for each run, and only the `main` branch of your repository is accepted.

### E2. Protected environment
Settings → Environments → New environment → **production** → *Required reviewers*: add yourself and one other person. Every deploy will wait for approval.

### E3. Branch protection
Edit `CODEOWNERS` (replace `@Mwanga-Limited/maintainers` with your real team or username), commit, then:
```bash
gh auth login
deploy/github/apply-ruleset.sh your-org/yapha-lms
```
This blocks direct pushes to `main`, requires a pull request with one approval and code-owner review, and requires the CI checks (`backend`, `frontend`, `image`, `e2e`, `analyze`). **Open `deploy/github/ruleset.json` first and check the check names match your workflow job names**, otherwise nothing can ever merge. Enable Dependabot alerts and secret scanning in Settings → Code security. The script also turns off merge commits (history must be linear: use squash or rebase), lets repository admins bypass through a pull request in an emergency, and the `analyze` check needs GitHub Advanced Security on private repositories. Create the `@Mwanga-Limited/maintainers` team first, or code-owner review can never be satisfied. Optionally set the repository variable `VITE_BETTERSTACK_ERRORS_DSN` so the browser error tracking is built into the image.

### E4. Prove a deploy works
Make a small change on a branch, open a pull request, let CI pass, merge, approve the `production` environment. The **Deploy** workflow builds the image, runs migrations, deploys, and checks health. Confirm the new revision in Cloud Run.
(Terraform ignores the image after creation, so running `terraform apply` later will not undo a deploy.)

---

## Part F. Go-live checklist (production readiness)

Do **all** of these before real users arrive. Tick them off.

**Backups (the most important part)**
- [ ] Run the backup once by hand: `gcloud run jobs execute yapha-backup --region REGION --wait`. Check `gs://PROJECT_ID-yapha-backups` has `db/<timestamp>/database.sql.gz`, `manifest.json`, `files/…` and `latest.json`.
- [ ] **Restore drill:** create a scratch database (a Neon branch, or a local Postgres), run `npm run migrate` against it, then `BACKUP_BUCKET=PROJECT_ID-yapha-backups SCRATCH_DATABASE_URL=... deploy/gcp/restore-drill.sh`. It must print `RESTORE DRILL PASSED`. Write down how long it took: that is your real recovery time. Delete the scratch database.
- [ ] Confirm Neon's point-in-time restore window (Neon console → Settings → Storage / Restore) covers what you need; the nightly backup job is the independent copy.
- [ ] After a few successful backups and a passed drill, decide the retention period and set `lock_backup_retention = true`, then `terraform apply`. **This is permanent**: nobody, including you, can delete backups early afterwards.

**Alerts**
- [ ] Confirm the alert email subscription (Google sends a verification email to `alert_email`; click it).
- [ ] Test the pipeline: Monitoring → Alerting → pick "Site is down" → check the policy is enabled and the channel is attached. For a real test, temporarily set the uptime check to a bad path, wait for the email, then fix it.
- [ ] Confirm the outbox worker runs: Cloud Scheduler → `yapha-outbox-drain` → *Last run: Success* (it runs every minute).
- [ ] Confirm the backup scheduler job exists and shows a next run at 02:00 UTC.

**Security**
- [ ] The super admin and every organisation's first Admin have the authenticator app on and recovery codes stored.
- [ ] `terraform.tfvars` and any file holding secrets is **not** committed (`git status`).
- [ ] IAM: Project → IAM: no human has Owner unless needed; use groups. The service accounts are created with the narrow roles in Terraform; don't add broad roles.
- [ ] Both buckets show *Public access prevention: enforced*.
- [ ] Neon: enable **IP Allow** if you can (Cloud Run has no fixed IP unless you add Cloud NAT), and keep the role passwords only in Secret Manager.
- [ ] `https://DOMAIN/api/metrics` returns 401 without the token (it is meant to be private; the token is in Secret Manager as `yapha-metrics-token`).

**Email**
- [ ] Send invitations to a Gmail and an Outlook address; open "Show original" and confirm `spf=pass dkim=pass dmarc=pass`.
- [ ] After a week of DMARC reports with no surprises, change `p=none` to `p=quarantine`, later `p=reject`.

**Capacity**
- [ ] `db_pool_max × max_instances` (default 10 × 4 = 40) is well below `db_max_connections` (100). Raise the database tier **before** raising `max_instances`.
- [ ] If you put your own load balancer in front of Cloud Run, change `TRUST_PROXY` from `1` to `2` in `main.tf`, otherwise per-address rate limits would see the load balancer's address.

**Process**
- [ ] Write down who is on call, where the secrets are (Secret Manager), and where `terraform.tfvars` and the state bucket are. Share `RUNBOOK.md`.
- [ ] Back up the `DATA_ENCRYPTION_KEY` value too (it encrypts each organisation's saved Paystack keys; if it is lost they must be entered again).
- [ ] Back up the `TOTP_ENCRYPTION_KEY` value (Secret Manager keeps versions, but record who can read it). If it is lost, authenticator apps stop working for everyone (people would need a 2FA reset).

---

## Part G. Day-to-day after launch

| Task | How |
|---|---|
| Deploy a change | Pull request → CI → merge → approve the `production` environment |
| Roll back a bad release (no migration in it) | `gcloud run services update-traffic yapha --region REGION --to-revisions=<previous-revision>=100` |
| Roll back past a migration | Restore from backup (`RUNBOOK.md` §5). Take a manual backup **before** any release containing a migration |
| See errors | Logs Explorer: `resource.type="cloud_run_revision" severity>=ERROR`; each error line has a `requestId` that matches what a user is shown |
| A person lost their phone | Admin: Users → **Reset 2FA**. Super admin: `RUNBOOK.md` §7 |
| Change a setting (e.g. SMTP host) | Edit `terraform.tfvars`, `terraform plan`, `terraform apply` (creates a new revision) |
| Rotate the 2FA encryption key | `RUNBOOK.md` §2 ("Existing authenticator secrets") |
| Quarterly | Restore drill; review IAM; update dependencies from Dependabot pull requests |
| Increase capacity | Raise the database tier first, then `max_instances` |

## Part H. If something goes wrong in setup

| Symptom | Likely cause and fix |
|---|---|
| `terraform apply` says an API is not enabled | Wait a minute after C2 and re-run; enabling APIs is eventually consistent |
| Cloud Run service fails to become ready during C6 | Migrations didn't run (C5), or a secret/permission is missing. Read the revision's logs |
| `/api/health` → `database: false` | `DATABASE_URL` secret wrong (must be the pooled Neon URL), or the Neon project is suspended |
| Upload fails in the browser, with a CORS error | `app_url` differs from the real address (http vs https, trailing slash, `www`). Fix and apply |
| Upload fails with `SignatureDoesNotMatch` or "cannot sign" | The runtime account lacks *Service Account Token Creator* on itself (Terraform sets it; check IAM) |
| Emails never arrive | `gcloud logging read 'jsonPayload.message:"mail"'`; check `SMTP_*` and the provider dashboard; mail waits in the `email_outbox` table and is retried |
| Domain mapping stuck | Domain not verified (B4) or DNS records not added/propagated (C7) |
| Deploy workflow can't authenticate | The repository variables (E1) are wrong, or the push was not to `main` |
| `terraform apply` wants to destroy or replace the Cloud Run service | **Stop.** The service has `deletion_protection`, so it should refuse; never remove that to "fix" a plan. The database is Neon and is not managed by Terraform: nothing here can delete it |

When a step fails and the cause isn't here, the first move is always the same: read the logs of the thing that failed (Cloud Run revision logs, job execution logs, `terraform` output) and look for a line with `severity: ERROR`.
