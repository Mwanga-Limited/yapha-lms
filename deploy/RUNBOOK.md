# Operations runbook

What a person on call needs. Everything here was exercised unless it says **not exercised**.

## 1. What runs where

| Part | What | State |
|---|---|---|
| `app` | One Node process: API (`/api/*`) and the built frontend | Stateless except uploads |
| PostgreSQL 13+ | All data. Row-level security isolates organisations | Back it up |
| Upload volume (`UPLOAD_DIR`, `/data/uploads`) | Photos, logos, lesson files and videos | Back it up **with** the database |
| Reverse proxy / load balancer | TLS, forwards to port 8080 | `TRUST_PROXY` = number of proxies in front |

One app instance only: uploads are on local disk and rate-limit counters are in memory. Do not scale out until uploads move to shared storage.

## 2. Deploying

1. Build: `docker build -t yapha-lms:<version> .` (CI builds it on every push).
2. **Back up first** (section 4). Migrations only go forward; there are no down scripts.
3. Run migrations as their own step: `node src/scripts/migrate.js` (compose service `migrate`). It takes an advisory lock, so two deployments cannot collide, and it fails loudly if the database user cannot switch to the `yapha_app` role.
4. Start the new `app`. It sends nothing to users until it is serving.
5. Check `GET /api/health`: `{"ok":true,"checks":{"database":true,"migrations":true,"storage":true}}`. A 503 names the failing check.
6. First deployment only: create the platform super admin once with
   `SUPERADMIN_EMAIL=… SUPERADMIN_PASSWORD=… node src/scripts/seed-superadmin.js` (12+ characters). Never run `seed:demo` in production (it refuses).

Stopping the app (`docker stop`, SIGTERM) finishes in-flight requests, then exits; it force-exits after 25 s.

### Rolling back
- **No new migration in the release:** deploy the previous image.
- **The release added a migration:** the previous image may not work with the new schema. Restore the pre-deployment backup (section 5) into a new database and point the app at it, or ship a fixed version forward. Decide this before deploying, not during the incident.

## 3. Configuration that must be right in production

The app refuses to start when `JWT_SECRET` is shorter than 32 characters or still a placeholder, or when `MAIL_TRANSPORT` is not `smtp` (the console transport writes sign-in codes and reset links into the logs).

| Variable | Notes |
|---|---|
| `DATABASE_URL` | A **non-superuser** that owns the database and has `CREATEROLE` (the compose bootstrap does this). A superuser bypasses row-level security's runtime role switch. |
| `JWT_SECRET` | `openssl rand -base64 48`. Rotating it signs everyone out and invalidates file links. |
| `APP_URL` | Public `https://` address (used in emails and certificates). |
| `TRUST_PROXY` | Number of proxies in front. Too high lets clients fake their IP (breaking rate limits and audit IPs); `0` behind a proxy makes everyone look like one IP. |
| `COOKIE_SECURE` | Defaults to true in production. Needs HTTPS. |
| `SMTP_*`, `MAIL_FROM` | Real SMTP. Failed sends are logged (`mail send failed`) and **not retried**. |
| `ORG_SIGNUP`, `ORG_SIGNUP_PER_HOUR` | Open organisation registration: set `closed` if you do not want strangers creating organisations. |
| `INVITES_PER_DAY`, `NEW_ORG_INVITES_PER_DAY`, `UPLOADS_PER_HOUR`, `ORG_STORAGE_MB` | Abuse limits; defaults 50, 5, 60, 5120. |
| `METRICS_TOKEN` | Enables `GET /api/metrics` (Bearer token). |

## 4. Backups

`deploy/backup.sh` dumps the database (custom format) and then the upload folder, with checksums.

```
DATABASE_URL=… UPLOAD_DIR=/data/uploads BACKUP_DIR=/backups BACKUP_UPLOAD_CMD='aws s3 cp --recursive {dir} s3://my-bucket/yapha/{name}' ./deploy/backup.sh
```

- Schedule it at least daily (cron or the platform's scheduler; **not set up for you**). Take one before every deployment.
- A backup on the same disk as the database is not a backup: set `BACKUP_UPLOAD_CMD` or copy `BACKUP_DIR` off the machine. Enable encryption and access control on that storage: the dump contains personal data.
- The database is dumped first, then the files, so every file the database refers to is in the archive.
- Row-level security is forced, so the script sets the platform bypass flag for its own session only.
- Recommended: also enable your database host's point-in-time recovery if it has one.

## 5. Restoring (and the restore drill)

```
RESTORE_DATABASE_URL=postgres://postgres:…@host/new_empty_db ./deploy/restore.sh /backups/<timestamp> /data/uploads-restored
```

It verifies checksums, refuses a non-empty database or folder, restores, then prints counts and checks that **every file the database references exists on disk** (exit 2 if not). It needs a superuser (or BYPASSRLS) connection because PostgreSQL does not allow `COPY` into forced-RLS tables for anyone else.

**Drill record.** On 2026-11-09, on a throwaway PostgreSQL 18 cluster (not production): seeded database and an upload folder backed up as the non-superuser owner and restored as a superuser into an empty database. Counts matched the source (3 organisations, 7 users, 3 audit entries, 1 file, 0 missing files); a second restore into the same database was refused; a deliberately corrupted archive was refused. **Repeat this drill against real data before go-live and every quarter**, and note the date and the time it took here.

After a restore: point `DATABASE_URL` at the restored database, mount the restored uploads, run `node src/scripts/migrate.js` (should report nothing to apply), check `/api/health`.

## 6. Monitoring and alerts to set up

The app exposes the signals; **the alerting itself is not configured** (it depends on your monitoring tool).

| Signal | Source | Suggested alert |
|---|---|---|
| App up and database reachable | `GET /api/health` every minute | Non-200 for 2 minutes |
| Server errors | `http_requests_total{status="5xx"}` or log `level:"error"` | More than 5 in 5 minutes |
| Slow requests | `http_request_duration_seconds` histogram | p95 above 1 s for 10 minutes |
| Database pool exhausted | `db_pool_connections{state="waiting"}` | Above 0 for 5 minutes |
| Rate limiting hitting real users | 429 share of `4xx`, log `status:429` | Sustained rise |
| Mail failing | log `msg:"mail send failed"` (the error text names the SMTP problem) | Any in 15 minutes |
| Disk | uploads volume and database volume usage | Above 80% |
| Backups | age of newest backup | Older than 26 hours |
| Memory / restarts | `process_resident_memory_bytes`, container restarts | Repeated restarts |

## 7. Logs

JSON, one object per line: stdout for `info`, stderr for `warn`/`error`. Every request logs `requestId`, `method`, `path`, `status`, `ms`, `tenant`, `userId`, `ip`. Passwords, tokens, sign-in codes and email subjects are not logged. `ip` and `userId` are personal data, and an SMTP error message can contain a recipient address, so set a retention period and access controls on your log store. Users and support can quote the **reference** shown with unexpected errors (the first 8 characters of the request id); search the logs for it. `LOG_LEVEL` controls verbosity.

## 8. Common incidents

- **Everyone gets 429 on sign-in:** counters are per network address and organisation, for sign-in style actions only. A very large group behind one address may need `AUTH_RATE_LIMIT_MAX` raised. Check `TRUST_PROXY` first: if it is `0` behind a proxy, all users share the proxy's address.
- **Health says `migrations:false`:** a release was deployed without its migration step. Run `node src/scripts/migrate.js`.
- **Every request fails with "permission denied to set role":** the database user lost membership of `yapha_app`. Run `node src/scripts/migrate.js` (it repairs the grant) or, as a CREATEROLE user: `GRANT yapha_app TO <user> WITH SET TRUE;`.
- **Uploads return 413 `STORAGE_FULL`:** an organisation reached `ORG_STORAGE_MB`. Raise it or ask them to remove unused files (the app does not delete files itself).
- **Verification / invitation emails not arriving:** check `mail send failed` logs and the SMTP provider. Users can request a new verification email or a password reset; invitees can use "Forgot your password".
- **Account locked out:** five wrong passwords lock an email for 15 minutes (by design; it also means someone can lock out a known address).

## 9. Known limits (accepted for the first release)

Single instance; uploads on local disk; rate-limit counters in memory; emails not retried; TOTP secrets stored unencrypted in the database; no recovery codes for authenticator apps; the application has not been load-tested above about 150–230 requests per second on one process with a small data set.
