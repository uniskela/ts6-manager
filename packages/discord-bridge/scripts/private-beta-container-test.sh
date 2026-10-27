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
  rm -rf "$HOST"
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
  if [ -r "$HOST/private-beta-status.json" ]; then break; fi
  sleep 0.2
done
if [ ! -r "$HOST/private-beta-status.json" ]; then
  echo "FAIL  host cannot read status while container is running (rootless bind mount)" >&2
  exit 1
fi
python3 - "$HOST/private-beta-status.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1], encoding="utf8"))
assert s.get("mode") == "private-beta"
assert s.get("daveReady") is True
text = json.dumps(s)
assert "token" not in text
assert "password" not in text
print("PASS  host can read status while running")
PY

docker stop d1-private-beta-mount-probe >/dev/null
if [ ! -r "$HOST/private-beta-status.json" ]; then
  echo "FAIL  status unreadable after SIGTERM" >&2
  exit 1
fi
python3 - "$HOST/private-beta-status.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1], encoding="utf8"))
assert s.get("state") == "stopped"
print("PASS  SIGTERM wrote final status")
PY
echo "PASS  private-beta container mount probe"
