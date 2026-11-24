#!/usr/bin/env bash
# Back up the database AND the uploaded files as one consistent set.
#
#   DATABASE_URL=postgres://yapha:...@host/yapha_lms UPLOAD_DIR=/data/uploads BACKUP_DIR=/backups ./deploy/backup.sh
#
# Order matters: the database is dumped FIRST, then the files. The app never deletes files, so every file the dump
# refers to is in the archive (files uploaded in between are extra, which is harmless).
# Optional: BACKUP_UPLOAD_CMD="aws s3 cp --recursive {dir} s3://bucket/yapha/{name}" copies the set off the machine.
# A backup that stays on the same disk as the database is not a backup: always set BACKUP_UPLOAD_CMD or copy BACKUP_DIR elsewhere.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
# pg_dump needs a direct connection, not a pooler: prefer DATABASE_URL_UNPOOLED when set
DATABASE_URL="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"
UPLOAD_DIR="${UPLOAD_DIR:-uploads}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

name="$(date -u +%Y%m%dT%H%M%SZ)"
dir="$BACKUP_DIR/$name"
mkdir -p "$dir"

# Row-level security is FORCED on every table, so even the owner sees nothing unless the platform bypass flag is set.
# The flag only affects this one dump session.
PGOPTIONS="-c app.bypass=on" pg_dump --format=custom --no-owner --enable-row-security --file="$dir/database.dump" "$DATABASE_URL"

if [ -d "$UPLOAD_DIR" ]; then
  tar -C "$UPLOAD_DIR" -czf "$dir/uploads.tar.gz" .
else
  echo "warning: $UPLOAD_DIR does not exist; backing up the database only" >&2
  : > "$dir/uploads.missing"
fi

( cd "$dir" && sha256sum -- * > SHA256SUMS )
printf 'created=%s\ndatabase=database.dump\nuploads=uploads.tar.gz\n' "$name" > "$dir/MANIFEST"
echo "backup written to $dir"

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  cmd="${BACKUP_UPLOAD_CMD//\{dir\}/$dir}"; cmd="${cmd//\{name\}/$name}"
  eval "$cmd"
  echo "backup copied off the machine"
fi

# Prune old local sets (the off-machine copy has its own retention).
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} +
