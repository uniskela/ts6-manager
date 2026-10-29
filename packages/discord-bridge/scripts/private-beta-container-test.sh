#!/usr/bin/env bash
# Rootless bind-mount + SIGTERM probe. No Discord. No TeamSpeak. No secrets.
# usage: scripts/private-beta-container-test.sh [image]
set -euo pipefail
IMG="${1:-}"
if [ -z "$IMG" ]; then
  echo "usage: $0 <image>" >&2
  exit 2
fi
APP=/app/packages/discord-bridge
HOST="$(mktemp -d "${TMPDIR:-/tmp}/d1-beta-mount.XXXXXX")"
chmod 0755 "$HOST"
cleanup() {
  docker rm -f d1-private-beta-mount-probe >/dev/null 2>&1 || true
  docker run --rm --user 0 --network none --entrypoint sh \
    -v "$HOST:/data" "$IMG" -c 'chown -R 0:0 /data' >/dev/null 2>&1 || true
  chmod -R u+rwX "$HOST" 2>/dev/null || true
  rm -rf "$HOST" || true
}
trap cleanup EXIT

docker run --rm --user 0 --network none --entrypoint sh \
  -v "$HOST:/data" "$IMG" -c 'chown -R 1000:1000 /data && chmod 0755 /data' >/dev/null

docker run -d --name d1-private-beta-mount-probe \
  --user 1000:1000 --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --init --stop-timeout 10 \
  --tmpfs /tmp -v "$HOST:$APP/evidence" \
  --entrypoint ./node_modules/.bin/tsx \
  "$IMG" src/lab/private-beta-mount-probe.ts >/dev/null

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -r "$HOST/host-status.json" ]; then break; fi
  sleep 0.2
done
if [ ! -r "$HOST/host-status.json" ]; then
  echo "FAIL  host cannot read host-status while container is running (rootless bind mount)" >&2
  exit 1
fi
python3 - "$HOST/host-status.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1], encoding="utf8"))
assert s.get("mode") == "private-beta"
assert s.get("daveReady") is True
assert "events" not in s
assert "counters" not in s
text = json.dumps(s)
assert "token" not in text
assert "password" not in text
print("PASS  host can read minimal host-status while running")
PY

if [ ! -e "$HOST/private-beta-status.json" ]; then
  echo "FAIL  detailed status missing" >&2
  exit 1
fi
mode="$(stat -c '%a' "$HOST/private-beta-status.json")"
if [ "$mode" != "600" ]; then
  echo "FAIL  detailed status must be 0600 (found $mode)" >&2
  exit 1
fi
owner="$(stat -c '%u' "$HOST/private-beta-status.json")"
me="$(id -u)"
if [ "$me" != 0 ] && [ "$owner" != "$me" ] && [ -r "$HOST/private-beta-status.json" ]; then
  echo "FAIL  host must not read detailed status; use docker exec" >&2
  exit 1
fi
DETAIL="$(docker exec d1-private-beta-mount-probe cat "$APP/evidence/private-beta-status.json")" \
python3 - <<'PY'
import json, os
s = json.loads(os.environ["DETAIL"])
assert s.get("mode") == "private-beta"
assert "events" in s
print("PASS  docker exec reads detailed status")
PY

docker stop d1-private-beta-mount-probe >/dev/null
if [ ! -r "$HOST/host-status.json" ]; then
  echo "FAIL  host-status unreadable after SIGTERM" >&2
  exit 1
fi
python3 - "$HOST/host-status.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1], encoding="utf8"))
assert s.get("state") == "stopped"
print("PASS  SIGTERM wrote final host-status")
PY
if [ ! -e "$HOST/private-beta-status.json" ]; then
  echo "FAIL  detailed evidence not retained after SIGTERM" >&2
  exit 1
fi
echo "PASS  private-beta container mount probe"
