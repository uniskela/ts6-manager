#!/bin/sh
set -e
export SIDECAR_URL="${SIDECAR_URL:-http://127.0.0.1:9800}"
SP="${SIDECAR_PORT:-9800}"

i=0
while [ "$i" -lt 60 ]; do
  if nc -z 127.0.0.1 "$SP" 2>/dev/null; then
    break
  fi
  i=$((i+1))
  sleep 1
done

if ! nc -z 127.0.0.1 "$SP" 2>/dev/null; then
  echo "[start-backend] Sidecar not listening on 127.0.0.1:${SP}" >&2
  exit 1
fi

# Upgrade-aware Prisma schema apply (fresh install / older image → new schema)
/usr/local/bin/apply-schema.sh

exec node dist/index.js
