#!/usr/bin/env bash
# Production-server PILOT helper. Does not start, stop or reconfigure TeamSpeak.
# Does not touch manager compose. Does not start without --confirm.
# Commands: check | pull | up --confirm | status | logs | stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LAB="$ROOT/packages/discord-bridge/lab"
CANONICAL_ENV="$LAB/.env.pilot"
ENV_FILE="${D1_PILOT_ENV_FILE:-$CANONICAL_ENV}"
COMPOSE_FILE="$LAB/docker-compose.private-pilot.yml"
PROJECT="d1-private-pilot"
EVID_HOST="${D1_PILOT_EVIDENCE_DIR:-$LAB/evidence-pilot}"
CONTAINER_NAME="d1-private-pilot-bridge"
STATUS_IN_CONTAINER="/app/packages/discord-bridge/evidence/private-beta-status.json"
HOST_STATUS_FILE="host-status.json"
REQUIRED=(
  D1_DISCORD_TOKEN_SLOT_0 D1_DISCORD_TOKEN_SLOT_1 D1_DISCORD_TOKEN_SLOT_2
  D1_DISCORD_TOKEN_SLOT_3 D1_DISCORD_TOKEN_SLOT_4 D1_DISCORD_TOKEN_OVERFLOW
  D1_DISCORD_GUILD_ID D1_DISCORD_CHANNEL_ID D1_TS_HOST D1_TS_CHANNEL
  D1_PILOT_EXTERNAL_TS D1_PILOT_CHANNEL_CONFIRMED D1_PILOT_ACK
)

cmd="${1:-check}"
CONFIRM=0
if [ "$cmd" = "up" ]; then
  for arg in "${@:2}"; do
    case "$arg" in
      --confirm) CONFIRM=1 ;;
      *) echo "usage: $0 up --confirm" >&2; exit 2 ;;
    esac
  done
elif [ "$#" -gt 1 ]; then
  echo "usage: $0 check|pull|up --confirm|status|logs|stop" >&2
  exit 2
fi

env_file_val() {
  awk -F= -v key="$1" '$1==key {print substr($0, index($0,"=")+1); exit}' "$ENV_FILE"
}

same_file() {
  [ -e "$1" ] && [ -e "$2" ] && [ "$(stat -c '%d:%i' "$1")" = "$(stat -c '%d:%i' "$2")" ]
}

require_source_commit() {
  if [[ ! "${SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "set SOURCE_COMMIT to the approved full 40-character SHA" >&2
    exit 2
  fi
}

verify_image_revision() {
  require_source_commit
  img="${D1_BRIDGE_IMAGE:?}"
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "missing local image $img (run $0 pull)" >&2
    exit 2
  fi
  rev="$(docker image inspect "$img" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  if [ "$rev" != "$SOURCE_COMMIT" ]; then
    echo "image revision does not match SOURCE_COMMIT" >&2
    exit 2
  fi
}

compose() {
  D1_BRIDGE_IMAGE="${D1_BRIDGE_IMAGE:?}" SOURCE_COMMIT="${SOURCE_COMMIT:?}" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

presence() {
  if [ ! -f "$CANONICAL_ENV" ]; then
    echo "missing env file lab/.env.pilot" >&2
    exit 2
  fi
  if [ ! -f "$ENV_FILE" ]; then
    echo "missing env file" >&2
    exit 2
  fi
  if ! same_file "$ENV_FILE" "$CANONICAL_ENV"; then
    echo "D1_PILOT_ENV_FILE must be the same file as lab/.env.pilot" >&2
    exit 2
  fi
  ENV_FILE="$CANONICAL_ENV"
  require_source_commit
  mode="$(stat -c '%a' "$ENV_FILE")"
  if [ "$mode" != "600" ]; then
    echo "env file must be mode 0600 (found $mode)" >&2
    exit 2
  fi
  missing=0
  for k in "${REQUIRED[@]}"; do
    val="$(env_file_val "$k")"
    if [ -n "$val" ]; then echo "$k: SET"; else echo "$k: MISSING"; missing=1; fi
  done
  echo "runtime_mode=private-beta experimental=true restart=no published_ports=none"
  echo "pilot=external-ts ts_server_untouched=yes"
  if [ "$missing" -ne 0 ]; then
    echo "pilot blocked: required variables are MISSING"
    exit 2
  fi
  if [ "$(env_file_val D1_PILOT_EXTERNAL_TS)" != "1" ] || [ "$(env_file_val D1_PILOT_CHANNEL_CONFIRMED)" != "1" ]; then
    echo "pilot blocked: D1_PILOT_EXTERNAL_TS and D1_PILOT_CHANNEL_CONFIRMED must be 1" >&2
    exit 2
  fi
  if [ "$(env_file_val D1_PILOT_ACK)" != "cross-platform-forwarding-informed" ]; then
    echo "pilot blocked: D1_PILOT_ACK must be the informed-consent token (SET/MISSING only; value not printed)" >&2
    exit 2
  fi
  host="$(env_file_val D1_TS_HOST)"
  case "$host" in
    d1-ts6-lab|127.0.0.1|localhost) echo "pilot blocked: D1_TS_HOST must be the dedicated external test endpoint, not the disposable lab" >&2; exit 2 ;;
  esac
  img="${D1_BRIDGE_IMAGE:-}"
  if [[ ! "$img" =~ ^ghcr\.io/uniskela/ts6-manager/discord-bridge@sha256:[0-9a-f]{64}$ ]]; then
    echo "pilot blocked: D1_BRIDGE_IMAGE must be the exact GHCR digest (no latest/stable/tag-only)" >&2
    exit 2
  fi
  if [[ "$img" == *latest* || "$img" == *stable* ]]; then
    echo "pilot blocked: latest/stable tags are refused" >&2
    exit 2
  fi
}

check() {
  presence
  echo "presence complete. Live connections are not started. TeamSpeak is not touched."
}

pull() {
  presence
  echo "pulling ${D1_BRIDGE_IMAGE} (read-only registry credentials on this host)"
  docker pull "${D1_BRIDGE_IMAGE}"
  verify_image_revision
}

up() {
  presence
  if [ "$CONFIRM" -ne 1 ]; then
    echo "presence complete. Live connections are not started."
    echo "after the operator approves: $0 up --confirm"
    exit 0
  fi
  verify_image_revision
  export SOURCE_COMMIT D1_BRIDGE_IMAGE
  mkdir -p "$EVID_HOST"
  chmod 0755 "$EVID_HOST"
  echo "starting private-pilot image (digest only). TeamSpeak server is not modified."
  compose up -d --no-build --no-recreate
}

status() {
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)"
  payload=""
  if [ "$running" = "true" ]; then
    payload="$(docker exec "$CONTAINER_NAME" cat "$STATUS_IN_CONTAINER" 2>/dev/null || true)"
  fi
  file="$EVID_HOST/$HOST_STATUS_FILE"
  if [ -z "$payload" ] && [ -r "$file" ]; then payload="$(cat "$file")"; fi
  STATUS_JSON="$payload" python3 - "$running" <<'PY'
import json, os, sys
running = sys.argv[1] == "true"
raw = os.environ.get("STATUS_JSON", "").strip()
s = None
if raw:
    try:
        s = json.loads(raw)
    except json.JSONDecodeError:
        s = None
if not running:
    health = "stale" if s else "absent"
elif s is None:
    health = "absent"
else:
    h = s.get("health")
    health = h if h in ("ok", "degraded", "fail-closed", "starting") else "fail-closed"
if s:
    print(f"mode={s.get('mode')}")
    print(f"daveReady={s.get('daveReady')}")
    print(f"receiver={s.get('receiver')}")
    print(f"sourceCommit={s.get('sourceCommit')}")
print(f"health={health}")
print(f"container_running={'yes' if running else 'no'}")
PY
}

logs() {
  SOURCE_COMMIT="${SOURCE_COMMIT:-unknown}"
  export SOURCE_COMMIT D1_BRIDGE_IMAGE
  compose logs --tail 100 --no-color
}

stop() {
  SOURCE_COMMIT="${SOURCE_COMMIT:-unknown}"
  export SOURCE_COMMIT D1_BRIDGE_IMAGE
  compose stop
  compose rm -f
  echo "private-pilot stopped. TeamSpeak server was not touched."
}

case "$cmd" in
  check) check ;;
  pull) pull ;;
  up) up ;;
  status) status ;;
  logs) logs ;;
  stop) stop ;;
  *) echo "usage: $0 check|pull|up --confirm|status|logs|stop" >&2; exit 2 ;;
esac
