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

PRISMA_CLI="$BACKEND_DIR/node_modules/prisma/build/index.js"
if [ ! -f "$PRISMA_CLI" ]; then
  echo "[schema] Prisma CLI not found at $PRISMA_CLI" >&2
  exit 1
fi

# Ensure Prisma/CLI share the same SQLite file apply-schema is inspecting.
if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="file:$DB_FILE"
fi

NAMEKEY_CLI=""
if [ -f "$BACKEND_DIR/dist/voice/commands/playlist-namekey-finalize-cli.js" ]; then
  NAMEKEY_CLI="$BACKEND_DIR/dist/voice/commands/playlist-namekey-finalize-cli.js"
elif [ -f "$BACKEND_DIR/src/voice/commands/playlist-namekey-finalize-cli.ts" ]; then
  NAMEKEY_CLI="$BACKEND_DIR/src/voice/commands/playlist-namekey-finalize-cli.ts"
fi
if [ -z "$NAMEKEY_CLI" ]; then
  echo "[schema] playlist-namekey-finalize-cli missing" >&2
  exit 1
fi

run_namekey_cli() {
  flag="$1"
  if [ "${NAMEKEY_CLI%.ts}" != "$NAMEKEY_CLI" ]; then
    node --import tsx "$NAMEKEY_CLI" "$flag"
  else
    node "$NAMEKEY_CLI" "$flag"
  fi
}

# F1: refuse incompatible legacy playlist names BEFORE prisma db push mutates
# the schema. Read-only preflight; a failure leaves the original database and
# schema unchanged so the previous image can still start.
if [ "$DB_EXISTS" -eq 1 ]; then
  echo "[schema] Preflight: playlist nameKey compatibility (read-only, before db push)"
  if ! run_namekey_cli --preflight; then
    echo "[schema] Playlist name compatibility preflight failed — database left unchanged." >&2
    echo "[schema] Resolve duplicate/blank playlist names on a copy, or restore backup and stay on the previous image." >&2
    exit 1
  fi
fi

echo "[schema] Running: prisma db push --skip-generate (mode=$MODE)"
# The Prisma CLI's update check forks a detached node process. If the check hangs
# (for example when outbound traffic is filtered) it outlives this script and,
# after `exec node dist/index.js`, ends as a zombie under the backend (#466).
CHECKPOINT_DISABLE=1 node "$PRISMA_CLI" db push --skip-generate

# Playlist nameKey uniqueness is not expressible as Prisma @@unique (partial
# indexes + cross-namespace triggers). db push only adds the column/index.
# Finalise after push: JS backfill → conflict preflight → constraints.
# Conflicts refuse finalisation without renaming/deleting playlists; schema
# version is not recorded so the next start retries after the operator fixes
# duplicates (restore backup if needed).
echo "[schema] Finalising playlist nameKey uniqueness"
run_namekey_cli --confirm-finalize

# Seed is safe to re-run (script uses upsert / ignores existing values).
if node prisma/seed.mjs; then
  echo "[schema] Seed completed"
else
  echo "[schema] Seed skipped or failed (non-fatal)"
fi

printf '%s\n' "$CURRENT_VERSION" > "$VERSION_FILE"
echo "[schema] Recorded schema version $CURRENT_VERSION in $VERSION_FILE"
