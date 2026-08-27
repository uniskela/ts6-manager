#!/bin/sh
# Apply Prisma schema on container start.
# Detects fresh installs vs upgrades from an older image and logs clearly.
# Uses `db push` (SQLite / no migration history in this project).
set -e

BACKEND_DIR="${BACKEND_DIR:-/app/packages/backend}"
DATA_DIR="${DATA_DIR:-$BACKEND_DIR/data}"
DB_FILE="${DB_FILE:-$DATA_DIR/ts6webui.db}"
VERSION_FILE="$DATA_DIR/.schema-version"
SCHEMA_VERSION_FILE="${SCHEMA_VERSION_FILE:-$BACKEND_DIR/prisma/SCHEMA_VERSION}"

mkdir -p "$DATA_DIR"
cd "$BACKEND_DIR"

if [ -n "$APP_SCHEMA_VERSION" ]; then
  CURRENT_VERSION="$APP_SCHEMA_VERSION"
elif [ -f "$SCHEMA_VERSION_FILE" ]; then
  CURRENT_VERSION="$(tr -d '[:space:]' < "$SCHEMA_VERSION_FILE")"
else
  CURRENT_VERSION="unknown"
fi

PREVIOUS_VERSION=""
if [ -f "$VERSION_FILE" ]; then
  PREVIOUS_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
fi

DB_EXISTS=0
if [ -f "$DB_FILE" ]; then
  DB_EXISTS=1
fi

MODE="fresh"
if [ "$DB_EXISTS" -eq 1 ]; then
  if [ -z "$PREVIOUS_VERSION" ]; then
    MODE="upgrade"
    echo "[schema] Existing database found without a schema version marker — treating as upgrade from an older image"
  elif [ "$PREVIOUS_VERSION" != "$CURRENT_VERSION" ]; then
    MODE="upgrade"
    echo "[schema] Upgrade detected: $PREVIOUS_VERSION → $CURRENT_VERSION"
  else
    MODE="reconcile"
    echo "[schema] Schema version $CURRENT_VERSION already recorded — reconciling with Prisma (idempotent)"
  fi
else
  echo "[schema] Fresh install — applying schema version $CURRENT_VERSION"
fi

echo "[schema] Running: prisma db push --skip-generate (mode=$MODE)"
npx prisma db push --skip-generate

# Seed is safe to re-run (scripts should upsert / ignore conflicts)
if npx prisma db seed; then
  echo "[schema] Seed completed"
else
  echo "[schema] Seed skipped or failed (non-fatal)"
fi

printf '%s\n' "$CURRENT_VERSION" > "$VERSION_FILE"
echo "[schema] Recorded schema version $CURRENT_VERSION in $VERSION_FILE"
