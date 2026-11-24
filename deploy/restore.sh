#!/usr/bin/env bash
# Restore a backup made by backup.sh into an EMPTY database and an EMPTY upload folder, then verify it.
#
#   RESTORE_DATABASE_URL=postgres://postgres:...@host/yapha_restored ./deploy/restore.sh /backups/20260101T020000Z /data/uploads-restored
#
# RESTORE_DATABASE_URL must be a SUPERUSER (or BYPASSRLS) connection to an existing, empty database: PostgreSQL does not
# allow COPY into tables with forced row-level security for anyone else. The script refuses to touch a database that
# already has tables, so it cannot overwrite live data.
set -euo pipefail

backup="${1:?usage: restore.sh <backup dir> <target upload dir>}"
uploads_target="${2:?usage: restore.sh <backup dir> <target upload dir>}"
: "${RESTORE_DATABASE_URL:?set RESTORE_DATABASE_URL (superuser connection to an empty database)}"

( cd "$backup" && sha256sum --check --quiet SHA256SUMS ) || { echo "checksum mismatch: the backup is damaged" >&2; exit 1; }

existing="$(psql "$RESTORE_DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[ "$existing" = "0" ] || { echo "refusing to restore: the target database already has $existing tables" >&2; exit 1; }
if [ -d "$uploads_target" ] && [ -n "$(ls -A "$uploads_target")" ]; then echo "refusing to restore: $uploads_target is not empty" >&2; exit 1; fi

# The dump grants privileges to the restricted runtime role; it must exist (roles are cluster-wide, not in the dump).
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yapha_app') THEN CREATE ROLE yapha_app NOLOGIN NOBYPASSRLS; END IF;
END $$;
SQL

pg_restore --no-owner --exit-on-error --dbname="$RESTORE_DATABASE_URL" "$backup/database.dump"

mkdir -p "$uploads_target"
[ -f "$backup/uploads.tar.gz" ] && tar -C "$uploads_target" -xzf "$backup/uploads.tar.gz"

echo "--- verification"
q() { PGOPTIONS="-c app.bypass=on" psql "$RESTORE_DATABASE_URL" -tA -c "$1"; }
echo "migrations applied: $(q 'SELECT count(*) FROM schema_migrations')"
echo "organisations:      $(q 'SELECT count(*) FROM tenants')"
echo "users:              $(q 'SELECT count(*) FROM users')"
echo "certificates:       $(q 'SELECT count(*) FROM certificates')"
echo "audit entries:      $(q 'SELECT count(*) FROM audit_logs')"
missing=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$uploads_target/$f" ] || { echo "MISSING FILE: $f" >&2; missing=$((missing + 1)); }
done < <(q 'SELECT storage_name FROM files')
echo "files referenced by the database: $(q 'SELECT count(*) FROM files'), missing on disk: $missing"
[ "$missing" = "0" ] || exit 2
echo "restore verified"
