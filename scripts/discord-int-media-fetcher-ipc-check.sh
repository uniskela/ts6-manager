#!/usr/bin/env bash
# Offline INT media-fetcher IPC validation (no Discord tunnel / interactions).
# Starts fetcher+proxy on named volumes, runs ipc-check, tears down on exit unless KEEP=1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f docker-compose.discord-int-media-fetcher.yml)
SEED="${MEDIA_FETCHER_SEED_TOKEN_FILE:-$ROOT/.media-fetcher-token-int}"

cleanup() {
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "KEEP=1 — leaving stack up"
    return
  fi
  # Only this compose file's fetcher/proxy/token oneshot. No -v (keeps named
  # volumes). Never touches INT TS compose or production stacks.
  "${COMPOSE[@]}" --profile ipc-check down --remove-orphans || true
}
trap cleanup EXIT

if [[ ! -f "$SEED" ]]; then
  umask 077
  openssl rand -hex 32 >"$SEED"
  echo "created seed token at ${SEED##*/} (contents omitted)"
fi
# Owner-only seed; never chmod 644/777
chmod 600 "$SEED" || true

export MEDIA_FETCHER_SEED_TOKEN_FILE="$SEED"

echo "==> building/starting INT media-fetcher (named volumes)"
"${COMPOSE[@]}" up --build -d media-fetcher-token media-egress-proxy media-fetcher

echo "==> waiting for jobs socket inside volume"
ready=0
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T media-fetcher \
    node -e "require('fs').accessSync('/jobs/jobs.sock');" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.25
done
if [[ "$ready" != "1" ]]; then
  echo "jobs socket not ready" >&2
  "${COMPOSE[@]}" logs --no-color --tail 80 media-fetcher media-egress-proxy || true
  exit 1
fi

echo "==> ipc-check (authorised + fail-closed)"
"${COMPOSE[@]}" --profile ipc-check run --rm --no-deps media-fetcher-ipc-check

echo "==> offline IPC validation complete (not audible radio acceptance)"
