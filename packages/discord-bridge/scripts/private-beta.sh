#!/usr/bin/env bash
# Isolated Bridge-D1 private-beta. Local image only. Does not publish ports.
# Does not restart a dead container. Does not start live Discord without --confirm.
# Commands: check | build | up --confirm | status | logs | stop | rollback <full-sha>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LAB="$ROOT/packages/discord-bridge/lab"
ENV_FILE="${D1_ENV_FILE:-$LAB/.env}"
COMPOSE_FILE="$LAB/docker-compose.private-beta.yml"
PROJECT="d1-private-beta"
NET="${D1_TS_NET:-d1-ts-lab}"
EVID_HOST="${D1_EVIDENCE_DIR:-$LAB/evidence}"
STATUS_IN_CONTAINER="/app/packages/discord-bridge/evidence/private-beta-status.json"
CONTAINER_NAME="d1-private-beta-bridge"
REQUIRED=(
  D1_DISCORD_TOKEN_SLOT_0 D1_DISCORD_TOKEN_SLOT_1 D1_DISCORD_TOKEN_SLOT_2
  D1_DISCORD_TOKEN_SLOT_3 D1_DISCORD_TOKEN_SLOT_4 D1_DISCORD_TOKEN_OVERFLOW
  D1_DISCORD_GUILD_ID D1_DISCORD_CHANNEL_ID D1_TS_HOST
)

cmd="${1:-check}"
CONFIRM=0
ROLLBACK_SHA=""
if [ "$cmd" = "up" ]; then
  for arg in "${@:2}"; do
    case "$arg" in
      --confirm) CONFIRM=1 ;;
      *) echo "usage: $0 up --confirm" >&2; exit 2 ;;
    esac
  done
elif [ "$cmd" = "rollback" ]; then
  ROLLBACK_SHA="${2:-}"
  if [ -z "$ROLLBACK_SHA" ]; then
    echo "usage: $0 rollback <full-sha>" >&2
    exit 2
  fi
elif [ "$#" -gt 1 ]; then
  echo "usage: $0 check|build|up --confirm|status|logs|stop|rollback <full-sha>" >&2
  exit 2
fi

source_commit() {
  git -C "$ROOT" rev-parse HEAD 2>/dev/null || true
}

compose() {
  SOURCE_COMMIT="${SOURCE_COMMIT:?}" docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

env_file_val() {
  awk -F= -v key="$1" '$1==key {print substr($0, index($0,"=")+1); exit}' "$ENV_FILE"
}

presence() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "missing env file" >&2
    exit 2
  fi
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
  if [ "$(env_file_val D1_RUNTIME_MODE)" = "private-beta" ] || [ "${D1_RUNTIME_MODE:-}" = "private-beta" ]; then
    echo "D1_RUNTIME_MODE: SET"
  else
    echo "D1_RUNTIME_MODE: MISSING"
    missing=1
  fi
  if [ "$(env_file_val D1_DAVE_SINGLE_ATTEMPT)" = "1" ] || [ "${D1_DAVE_SINGLE_ATTEMPT:-}" = "1" ]; then
    echo "D1_DAVE_SINGLE_ATTEMPT: SET"
  else
    echo "D1_DAVE_SINGLE_ATTEMPT: MISSING"
  fi
  echo "runtime_mode=private-beta experimental=true restart=no published_ports=none"
  echo "acceptance A-D stay in lab/ACCEPTANCE.md; do not mix those PASS/FAIL rows into usage counters"
  if [ "$missing" -ne 0 ]; then
    echo "private-beta blocked: required variables are MISSING"
    exit 2
  fi
}

check() {
  presence
  echo "presence complete. Live Discord connections are not started."
  echo "lab network: $NET (must already exist and must not be --internal)"
}

build() {
  SOURCE_COMMIT="${SOURCE_COMMIT:-$(source_commit)}"
  if [ -z "$SOURCE_COMMIT" ]; then
    echo "set SOURCE_COMMIT (not a git checkout)" >&2
    exit 2
  fi
  export SOURCE_COMMIT
  echo "building ts6-discord-bridge-private-beta:$SOURCE_COMMIT (local only, do not push)"
  compose build
}

require_net() {
  if ! docker network inspect "$NET" >/dev/null 2>&1; then
    echo "missing lab network $NET (start packages/discord-bridge/scripts/d1-ts-lab.sh start)" >&2
    exit 2
  fi
  internal="$(docker network inspect -f '{{.Internal}}' "$NET")"
  if [ "$internal" = "true" ]; then
    echo "lab network $NET is internal; Discord would be unreachable" >&2
    exit 2
  fi
}

up() {
  presence
  if [ "$CONFIRM" -ne 1 ]; then
    echo "presence complete. Live Discord connections are not started."
    echo "after the operator approves: $0 up --confirm"
    exit 0
  fi
  require_net
  SOURCE_COMMIT="${SOURCE_COMMIT:-$(source_commit)}"
  if [ -z "$SOURCE_COMMIT" ]; then
    echo "set SOURCE_COMMIT (not a git checkout)" >&2
    exit 2
  fi
  export SOURCE_COMMIT
  if ! docker image inspect "ts6-discord-bridge-private-beta:$SOURCE_COMMIT" >/dev/null 2>&1; then
    echo "missing local image ts6-discord-bridge-private-beta:$SOURCE_COMMIT (run $0 build)" >&2
    exit 2
  fi
  mkdir -p "$EVID_HOST"
  # 0755: rootless remaps container uid 1000; host must still be able to traverse the bind mount.
  chmod 0755 "$EVID_HOST"
  docker run --rm --user 0 --network none --entrypoint sh \
    -v "$EVID_HOST:/data" \
    "ts6-discord-bridge-private-beta:$SOURCE_COMMIT" \
    -c 'chown -R 1000:1000 /data && chmod 0755 /data' >/dev/null
  echo "starting private-beta image ts6-discord-bridge-private-beta:$SOURCE_COMMIT"
  compose up -d --no-build --no-recreate
}

container_running() {
  docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false
}

status() {
  running="$(container_running)"
  payload=""
  if [ "$running" = "true" ]; then
    payload="$(docker exec "$CONTAINER_NAME" cat "$STATUS_IN_CONTAINER" 2>/dev/null || true)"
  fi
  file="$EVID_HOST/private-beta-status.json"
  if [ -z "$payload" ] && [ -r "$file" ]; then
    payload="$(cat "$file")"
  fi
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
    print(f"experimental={s.get('experimental')}")
    print(f"sourceCommit={s.get('sourceCommit')}")
    print(f"state={s.get('state')}")
    print(f"daveReady={s.get('daveReady')}")
    print(f"receiver={s.get('receiver')}")
    print(f"generation={s.get('generation')}")
    print(f"scheduledReconnects={s.get('scheduledReconnects')}")
    c = s.get("counters") or {}
    print(f"decryptErrors={c.get('decryptErrors')}")
    print(f"daveReplacements={c.get('daveReplacements')}")
    print(f"recoveries={c.get('recoveries')}")
    print(f"framesSent={c.get('framesSent')}")
    print(f"events={len(s.get('events') or [])}")
else:
    print("status file: absent")
print(f"health={health}")
print(f"container_running={'yes' if running else 'no'}")
PY
  if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker inspect -f 'restart_policy={{.HostConfig.RestartPolicy.Name}} published_ports={{len .NetworkSettings.Ports}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER_NAME"
  else
    echo "container: absent"
  fi
}

logs() {
  SOURCE_COMMIT="${SOURCE_COMMIT:-$(source_commit)}"
  export SOURCE_COMMIT
  compose logs --tail 100 --no-color
}

stop() {
  SOURCE_COMMIT="${SOURCE_COMMIT:-$(source_commit)}"
  if [ -z "$SOURCE_COMMIT" ]; then SOURCE_COMMIT=unknown; fi
  export SOURCE_COMMIT
  compose stop
  compose rm -f
  if docker image inspect "ts6-discord-bridge-private-beta:$SOURCE_COMMIT" >/dev/null 2>&1; then
    docker run --rm --user 0 --network none --entrypoint sh \
      -v "$EVID_HOST:/data" \
      "ts6-discord-bridge-private-beta:$SOURCE_COMMIT" \
      -c 'chown -R 0:0 /data' >/dev/null || true
  fi
  chmod -R u+rwX,go-rwx "$EVID_HOST" || true
  echo "private-beta stopped. image and evidence kept. ts lab not touched."
}

rollback() {
  if ! docker image inspect "ts6-discord-bridge-private-beta:$ROLLBACK_SHA" >/dev/null 2>&1; then
    echo "missing previous image ts6-discord-bridge-private-beta:$ROLLBACK_SHA" >&2
    echo "keep the previous local tag before rebuilding" >&2
    exit 2
  fi
  echo "rolling back to local image ts6-discord-bridge-private-beta:$ROLLBACK_SHA (no rebuild, no pull)"
  SOURCE_COMMIT="${SOURCE_COMMIT:-$(source_commit)}"
  if [ -z "$SOURCE_COMMIT" ]; then SOURCE_COMMIT=unknown; fi
  export SOURCE_COMMIT
  compose stop
  compose rm -f
  export SOURCE_COMMIT="$ROLLBACK_SHA"
  compose up -d --no-build --no-recreate
}

case "$cmd" in
  check) check ;;
  build) build ;;
  up) up ;;
  status) status ;;
  logs) logs ;;
  stop) stop ;;
  rollback) rollback ;;
  *) echo "usage: $0 check|build|up --confirm|status|logs|stop|rollback <full-sha>" >&2; exit 2 ;;
esac
