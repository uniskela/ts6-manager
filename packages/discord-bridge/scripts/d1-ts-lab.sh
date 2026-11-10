#!/usr/bin/env bash
# Disposable TeamSpeak 6 lab on this host. Isolated from production.
# Commands: start | stop | status | handshake
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
NAME="${D1_TS_LAB_NAME:-d1-ts6-lab}"
NET="${D1_TS_NET:-d1-ts-lab}"
VOL="${D1_TS_LAB_VOLUME:-d1-ts6-lab-data}"
IMG="${D1_TS_LAB_IMAGE:-teamspeaksystems/teamspeak6-server:6.0.0-beta13}"
HOST_UDP="${D1_TS_LAB_HOST_PORT:-19987}"
LOOPBACK_BIND=127.0.0.1

cmd="${1:-status}"

have() { docker inspect "$1" >/dev/null 2>&1; }

bind_summary() {
  D1_TS_LAB_HOST_PORT="$HOST_UDP" python3 - <<'PY'
import os, subprocess
port = os.environ["D1_TS_LAB_HOST_PORT"]
out = subprocess.check_output(["ss", "-ulnH"], text=True)
loopback = wildcard = tailscale = 0
suffix = ":" + port
for line in out.splitlines():
    parts = line.split()
    local = parts[4] if len(parts) > 4 else ""
    if not local.endswith(suffix):
        continue
    if local.startswith("127.0.0.1:"):
        loopback = 1
    elif local.startswith("0.0.0.0:") or local.startswith("[::]:") or local.startswith("*:") :
        wildcard = 1
    elif local.startswith("100."):
        tailscale = 1
print(f"udp_{port}_loopback={'yes' if loopback else 'no'}")
print(f"udp_{port}_tailscale={'yes' if tailscale else 'no'}")
print(f"udp_{port}_wildcard={'yes' if wildcard else 'no'}")
PY
}

start() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  if have "$NAME"; then
    echo "ts_lab: already exists ($NAME)"
    return
  fi
  publish=(-p "${LOOPBACK_BIND}:${HOST_UDP}:9987/udp")
  tsip=""
  if command -v tailscale >/dev/null; then
    tsip="$(tailscale ip -4 2>/dev/null || true)"
  fi
  extra=()
  if [ -n "$tsip" ] && [ "$tsip" != "$LOOPBACK_BIND" ] && [ "${tsip#127.}" = "$tsip" ]; then
    extra=(-p "${tsip}:${HOST_UDP}:9987/udp")
  fi
  launch() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    sleep 1
    docker run -d --name "$NAME" --hostname "$NAME" --network "$NET" \
      --memory 512m \
      "$@" \
      -e TSSERVER_LICENSE_ACCEPTED=accept \
      -v "${VOL}:/var/tsserver" \
      "$IMG" >/dev/null
  }
  # Rootless slirp often accepts one host mapping per container port.
  if [ "${#extra[@]}" -gt 0 ] && launch "${extra[@]}"; then
    echo "ts_lab: tailscale_bind=ok"
  elif launch "${publish[@]}"; then
    echo "ts_lab: tailscale_bind=skipped_loopback_only"
  else
    echo "ts_lab: could not publish UDP $HOST_UDP" >&2
    exit 1
  fi
  echo "ts_lab: started $NAME on $NET"
}

stop() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "ts_lab: removed $NAME $VOL $NET"
}

status() {
  if have "$NAME"; then
    echo "ts_lab: running=$(docker inspect -f '{{.State.Running}}' "$NAME")"
  else
    echo "ts_lab: absent"
  fi
  if docker network inspect "$NET" >/dev/null 2>&1; then
    echo "ts_net: present (not internal)"
    docker network inspect "$NET" --format '{{if .Internal}}ts_net_internal=yes{{else}}ts_net_internal=no{{end}}'
  else
    echo "ts_net: absent"
  fi
  if have "$NAME"; then
    docker inspect -f '{{json .HostConfig.PortBindings}}' "$NAME" | python3 -c '
import json, sys
d = json.load(sys.stdin)
binds = d.get("9987/udp") or []
print("publish_loopback=" + ("yes" if any(b.get("HostIp") == "127.0.0.1" for b in binds) else "no"))
print("publish_tailscale=" + ("yes" if any(str(b.get("HostIp", "")).startswith("100.") for b in binds) else "no"))
print("publish_wildcard=" + ("yes" if any(b.get("HostIp") in ("", "0.0.0.0", "::") for b in binds) else "no"))
print("publish_host_port=" + ((binds[0].get("HostPort") if binds else "none") or "none"))
'
  fi
  bind_summary
}

handshake() {
  cd "$ROOT/packages/discord-bridge"
  TS_LAB_HOST=127.0.0.1 TS_LAB_PORT="$HOST_UDP" ./node_modules/.bin/tsx src/lab/ts-handshake.ts
}

case "$cmd" in
  start) start; status ;;
  stop) stop ;;
  status) status ;;
  handshake) handshake ;;
  *) echo "usage: $0 start|stop|status|handshake" >&2; exit 2 ;;
esac
