#!/usr/bin/env bash
# Isolated Bridge-D1 live container. Does not publish ports.
# Default: presence check only. Live start requires --confirm.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENV_FILE="${D1_ENV_FILE:-$ROOT/packages/discord-bridge/lab/.env}"
APP=/app/packages/discord-bridge
NET="${D1_TS_NET:-d1-ts-lab}"
REQUIRED=(
  D1_DISCORD_TOKEN_SLOT_0 D1_DISCORD_TOKEN_SLOT_1 D1_DISCORD_TOKEN_SLOT_2
  D1_DISCORD_TOKEN_SLOT_3 D1_DISCORD_TOKEN_SLOT_4 D1_DISCORD_TOKEN_OVERFLOW
  D1_DISCORD_GUILD_ID D1_DISCORD_CHANNEL_ID D1_TS_HOST
)
CONFIRM=0
if [ "${1:-}" = "--confirm" ]; then CONFIRM=1; shift; fi

if [ ! -f "$ENV_FILE" ]; then
  echo "missing env file" >&2
  exit 2
fi
mode="$(stat -c '%a' "$ENV_FILE")"
if [ "$mode" != "600" ]; then
  echo "env file must be mode 0600 (found $mode)" >&2
  exit 2
fi

# Presence only. Values are never printed.
missing=0
for k in "${REQUIRED[@]}"; do
  val="$(awk -F= -v key="$k" '$1==key {print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")"
  if [ -n "$val" ]; then echo "$k: SET"; else echo "$k: MISSING"; missing=1; fi
done
if [ "$missing" -ne 0 ]; then
  echo "live start blocked: required variables are MISSING"
  exit 2
fi
if [ "$CONFIRM" -ne 1 ]; then
  echo "presence complete. Live Discord connections are not started."
  echo "lab network: $NET (bridge joins this on --confirm; must not be --internal)"
  echo "After the operator approves the run: $0 --confirm"
  exit 0
fi
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  echo "missing lab network $NET (start packages/discord-bridge/scripts/d1-ts-lab.sh start)" >&2
  exit 2
fi
internal="$(docker network inspect -f '{{.Internal}}' "$NET")"
if [ "$internal" = "true" ]; then
  echo "lab network $NET is internal; Discord would be unreachable" >&2
  exit 2
fi
if [ -n "${D1_LAB_IMAGE:-}" ]; then
  IMG="$D1_LAB_IMAGE"
else
  sha="$(git -C "$ROOT" rev-parse --short=7 HEAD 2>/dev/null || true)"
  if [ -z "$sha" ]; then
    echo "set D1_LAB_IMAGE (not a git checkout)" >&2
    exit 2
  fi
  IMG="ts6-discord-bridge-lab:d1-${sha}"
fi

EVID_HOST="${D1_EVIDENCE_DIR:-$ROOT/packages/discord-bridge/lab/evidence}"
mkdir -p "$EVID_HOST"
chmod 0700 "$EVID_HOST"

# Rootless userns: container uid 1000 is not the host user. Make the bind
# mount writable for `node`, then give the files back to the host user.
chown_data() {
  # Needs CAP_CHOWN; this helper is not the live process.
  docker run --rm --user 0 --network none \
    -v "$EVID_HOST:/data" --entrypoint chown "$IMG" -R "$1" /data
}
chown_data "1000:1000"
restore_evidence() {
  chown_data "0:0" || true
  chmod -R u+rwX,go-rwx "$EVID_HOST" || true
}
trap restore_evidence EXIT

docker run --rm -i --name d1-live \
  --network "$NET" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --cpus 1 --memory 512m \
  --tmpfs /tmp \
  -v "$EVID_HOST:$APP/evidence" \
  --env-file "$ENV_FILE" \
  "$IMG" src/lab/live.ts
status=$?
exit "$status"
