#!/usr/bin/env bash
# Restore drill: prove the latest backup restores and matches what was backed up. Run it from a trusted machine (or Cloud Shell)
# with gcloud authenticated and psql installed. It NEVER touches production: it restores into a scratch database you name.
#
#   BACKUP_BUCKET=yapha-prod-backups SCRATCH_DATABASE_URL=postgres://postgres:...@127.0.0.1:5433/drill ./deploy/gcp/restore-drill.sh [db/20261109T020000Z]
#
# The scratch database must be empty, owned by the user in the URL, and the schema must be created by the migrations first
# (npm run migrate against the scratch database), because the dump contains data only in effect (INSERTs) and the app's roles.
set -euo pipefail
: "${BACKUP_BUCKET:?set BACKUP_BUCKET}"
: "${SCRATCH_DATABASE_URL:?set SCRATCH_DATABASE_URL (an EMPTY scratch database, never production)}"
case "$SCRATCH_DATABASE_URL" in *prod*|*production*) echo "refusing: the URL looks like production" >&2; exit 2;; esac

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
prefix="${1:-}"
if [ -z "$prefix" ]; then
  gcloud storage cp "gs://$BACKUP_BUCKET/latest.json" "$work/latest.json" --quiet
  prefix="$(python3 -c "import json,sys; print(json.load(open('$work/latest.json'))['databaseDump'].rsplit('/',1)[0])")"
fi
echo "restoring $prefix"
gcloud storage cp "gs://$BACKUP_BUCKET/$prefix/database.sql.gz" "$work/database.sql.gz" --quiet
gcloud storage cp "gs://$BACKUP_BUCKET/$prefix/manifest.json" "$work/manifest.json" --quiet

# Bypass row-level security for this restoring session only (FORCE RLS applies to the owner too).
gunzip -c "$work/database.sql.gz" | PGOPTIONS="-c app.bypass=on" psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -q >/dev/null

q() { PGOPTIONS="-c app.bypass=on" psql "$SCRATCH_DATABASE_URL" -At -c "$1"; }
want() { python3 -c "import json; print(json.load(open('$work/manifest.json'))['$1'])"; }
fail=0
for k in tenants users files; do
  tbl="$k"; [ "$k" = files ] && cond="WHERE status = 'ready'" || cond=""
  got="$(q "SELECT count(*) FROM $tbl $cond")"; exp="$(want "$k")"
  if [ "$got" = "$exp" ]; then echo "ok    $k: $got"; else echo "FAIL  $k: restored $got, backup said $exp" >&2; fail=1; fi
done

# Every file the database mentions must exist in the file copy.
q "SELECT 'tenants/' || tenant_id || '/' || storage_name FROM files WHERE status = 'ready'" | sort > "$work/wanted.txt"
gcloud storage ls "gs://$BACKUP_BUCKET/files/tenants/**" 2>/dev/null | sed "s#gs://$BACKUP_BUCKET/files/##" | sort > "$work/have.txt" || true
missing="$(comm -23 "$work/wanted.txt" "$work/have.txt" | wc -l | tr -d ' ')"
if [ "$missing" = 0 ]; then echo "ok    every file in the database exists in the backup"; else echo "FAIL  $missing file(s) referenced by the database are missing from the backup" >&2; fail=1; fi

[ "$fail" = 0 ] && echo "RESTORE DRILL PASSED ($prefix)" || { echo "RESTORE DRILL FAILED" >&2; exit 1; }
