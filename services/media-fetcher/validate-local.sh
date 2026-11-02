#!/bin/bash
# Isolated Gate C run against the production fetcher/proxy image. Not a deploy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/services/media-fetcher"
WORKDIR="${TMPDIR:-/tmp}/ts6-fetcher-gatec"
IMAGE=ts6-media-fetcher:local
WIMAGE=ts6-media-fetcher-world:local
TOKEN_FILE="$WORKDIR/token"
mkdir -p "$WORKDIR"
umask 077
openssl rand -hex 32 > "$TOKEN_FILE"
chmod 644 "$TOKEN_FILE"

P=ts6gatec
cleanup() {
  docker rm -f "$P-backend" "$P-fetcher" "$P-proxy" "$P-world" "$P-noll" >/dev/null 2>&1 || true
  docker network rm "${P}_fetch" "${P}_world" "${P}_app" >/dev/null 2>&1 || true
  docker volume rm "${P}_jobs" "${P}_ctl" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

docker build -t "$IMAGE" "$DIR"
docker build -t "$WIMAGE" -f "$DIR/fixtures/Dockerfile.world" "$DIR/fixtures"

docker network create --internal "${P}_fetch" >/dev/null
docker network create "${P}_world" >/dev/null
docker network create "${P}_app" >/dev/null
docker volume create "${P}_jobs" >/dev/null
docker volume create "${P}_ctl" >/dev/null
docker run --rm -u 0 -v "${P}_jobs:/jobs" -v "${P}_ctl:/ctl" "$IMAGE" chown -R node:node /jobs /ctl

common=(--user node --security-opt=no-new-privileges --read-only --tmpfs /tmp --cap-drop ALL)

docker run -d --name "$P-world" "${common[@]}" --network "${P}_world" --network-alias origin \
  "$WIMAGE" >/dev/null
for i in $(seq 1 80); do docker logs "$P-world" 2>&1 | grep -q 'WORLD ready' && break; sleep 0.25; done
docker logs "$P-world" 2>&1 | grep -q 'WORLD ready' || fail "world start"
docker exec "$P-world" cat /tmp/ca.crt > "$WORKDIR/ca.crt"
chmod 644 "$WORKDIR/ca.crt"
docker run --rm -u 0 -v "${P}_jobs:/jobs" -v "$WORKDIR/ca.crt:/ca.crt:ro" "$IMAGE" \
  sh -c 'cp /ca.crt /jobs/ca.crt && chmod 644 /jobs/ca.crt'

docker run -d --name "$P-proxy" "${common[@]}" --network "${P}_fetch" --network-alias media-egress-proxy \
  -v "${P}_ctl:/ctl" -e PROXY_CTL=/ctl/proxy.sock -e PROXY_PERMIT_PRIVATE=1 \
  "$IMAGE" node /app/proxy.mjs >/dev/null
docker network connect "${P}_world" "$P-proxy"
for i in $(seq 1 40); do docker logs "$P-proxy" 2>&1 | grep -q 'PROXY ready' && break; sleep 0.25; done
docker logs "$P-proxy" 2>&1 | grep -q 'PROXY ready' || fail "proxy start"

docker run -d --name "$P-fetcher" "${common[@]}" --network "${P}_fetch" \
  -v "${P}_jobs:/jobs" -v "${P}_ctl:/ctl" \
  -v "$TOKEN_FILE:/jobs/.token:ro" \
  -e JOBS_SOCK=/jobs/jobs.sock -e PROXY_CTL=/ctl/proxy.sock \
  -e PROXY_HOST=media-egress-proxy \
  -e MEDIA_FETCHER_TOKEN_FILE=/jobs/.token \
  -e MEDIA_FETCHER_CA_FILE=/jobs/ca.crt \
  -e FETCHER_FFMPEG_LOG=/jobs/ff.err \
  "$IMAGE" node /app/fetcher.mjs >/dev/null
for i in $(seq 1 40); do docker logs "$P-fetcher" 2>&1 | grep -q 'FETCHER ready' && break; sleep 0.25; done
docker logs "$P-fetcher" 2>&1 | grep -q 'FETCHER ready' || fail "fetcher start $(docker logs "$P-fetcher" 2>&1 | tail -5)"

backend() {
  docker run --rm --user node --network "${P}_app" --security-opt=no-new-privileges \
    --read-only --tmpfs /tmp --cap-drop ALL \
    -v "${P}_jobs:/jobs" \
    -v "$TOKEN_FILE:/jobs/.token:ro" \
    -v "$DIR/fixtures/client.mjs:/app/client.mjs:ro" \
    -e JOBS_SOCK=/jobs/jobs.sock \
    -e MEDIA_FETCHER_TOKEN_FILE=/jobs/.token \
    "$IMAGE" node /app/client.mjs "$@"
}

backend wait --ms 8000 >/dev/null || fail "job socket"
docker exec "$P-fetcher" sh -c 'test -r /jobs/ca.crt && wc -c /jobs/ca.crt' || fail "ca.crt missing in fetcher"

# Landlock actually enforced
WRAP_CHECK=$(docker exec "$P-fetcher" /usr/local/bin/ll-wrap --check) || fail "ll-wrap --check"
echo "$WRAP_CHECK" | grep -q 'landlock_abi=' || fail "ll-wrap abi line"
ABI=$(echo "$WRAP_CHECK" | sed -n 's/landlock_abi=//p')
[ "${ABI:-0}" -ge 4 ] || fail "ABI $ABI < 4"
pass "Landlock ABI $ABI"

# Networks / ports / no docker.sock
FETC_NETS=$(docker inspect "$P-fetcher" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
BACK_NETS=$(docker inspect "$P-backend" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || true)
# backend() is --rm; inspect a one-shot via compose-equivalent: client never joins fetch
echo "$FETC_NETS" | grep -q "${P}_fetch" || fail "fetcher not on fetch net"
echo "$FETC_NETS" | grep -q "${P}_app" && fail "fetcher joined app net"
docker inspect "$P-fetcher" --format '{{json .HostConfig.PortBindings}}' | grep -q '{}' || fail "fetcher published ports"
docker inspect "$P-proxy" --format '{{json .HostConfig.PortBindings}}' | grep -q '{}' || fail "proxy published ports"
docker inspect "$P-fetcher" --format '{{json .HostConfig.Binds}}' | grep -q docker.sock && fail "docker.sock"
docker inspect "$P-fetcher" --format '{{.HostConfig.Privileged}} {{.HostConfig.CapAdd}}' | grep -qi true && fail "privileged/caps"
SOCK_MODE=$(docker exec "$P-fetcher" stat -c '%a' /jobs/jobs.sock)
[ "$SOCK_MODE" = "660" ] || fail "jobs.sock mode $SOCK_MODE"
pass "topology and socket mode $SOCK_MODE"

# Auth
UNAUTH=$(backend unauth || true)
echo "$UNAUTH" | grep -q unauthorized || fail "unauth $UNAUTH"
pass "unix auth"

# PCM paths
HLS=$(backend submit --id legit --url https://origin:9443/live.m3u8 --ports 9443 || true)
echo "HLS $HLS"
HLS_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$HLS")
if [ "$HLS_BYTES" -le 1000 ]; then
  echo "ffmpeg-log:"; docker exec "$P-fetcher" sh -c 'cat /jobs/ff.err 2>/dev/null | tail -40' || true
  docker logs "$P-proxy" 2>&1 | tail -20 || true
  fail "hls bytes $HLS_BYTES"
fi
pass "HLS PCM $HLS_BYTES"

HTTP=$(backend submit --id http1 --url http://origin:8000/stream --ports 8000 || true)
HTTP_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$HTTP")
[ "$HTTP_BYTES" -gt 1000 ] || fail "http iceast $HTTP"
pass "HTTP Icecast $HTTP_BYTES"

HTTPS=$(backend submit --id https1 --url https://origin:9443/stream --ports 9443 || true)
HTTPS_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$HTTPS")
[ "$HTTPS_BYTES" -gt 1000 ] || fail "https iceast $HTTPS"
pass "HTTPS Icecast $HTTPS_BYTES"

# Original httpproxy HLS bypass
BYPASS=$(backend submit --id bypass --url https://origin:9443/bypass.m3u8 --ports 9443 || true)
BYPASS_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$BYPASS")
[ "$BYPASS_BYTES" -eq 0 ] || fail "bypass leaked $BYPASS"
TRAP=$(docker run --rm --network "${P}_world" "$IMAGE" node -e '
const http=require("http"); http.get("http://origin:9500/",res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>process.stdout.write(b));});
')
echo "$TRAP" | grep -F -q '"trapPeers":[]' || fail "trap peers $TRAP"
pass "httpproxy HLS bypass blocked"

# Cross-job + concurrent allowlists
backend hold-cancel --id jobB --url http://origin:8000/hold --ms 25000 --ports 8000 > "$WORKDIR/b.json" &
for i in $(seq 1 40); do grep -q shimPort "$WORKDIR/b.json" 2>/dev/null && break; sleep 0.2; done
BPORT=$(node -e "const t=require('fs').readFileSync(process.argv[1],'utf8'); const m=t.match(/\"shimPort\":(\\d+)/); if(!m) process.exit(2); process.stdout.write(m[1]);" "$WORKDIR/b.json")
[ -n "$BPORT" ] || fail "B shim $WORKDIR/b.json"
docker exec "$P-world" sh -c "printf '%s\n' '127.0.0.1:${BPORT}' > /tmp/cross-target"
A_CROSS=$(backend submit --id jobA --url https://origin:9443/cross.m3u8 --ports 9443 || true)
A2=$(backend submit --id jobA2 --url "httpproxy://127.0.0.1:${BPORT}/http://origin:8000/stream" --ports 9443 || true)
A2_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$A2")
[ "$A2_BYTES" -eq 0 ] || fail "cross-job inherit $A2"
BST=$(backend status || true)
echo "$BST" | grep -q jobB || fail "B gone during A2 $BST"
pass "cross-job shim blocked (B=$BPORT A2 bytes=$A2_BYTES)"

# Cancel / no leftover ffmpeg (jobB hold from the cross-job test must be gone first)
backend cancel --id jobB >/dev/null || true
wait || true
backend hold-cancel --id hold1 --url http://origin:8000/hold --ms 800 --ports 8000 >/dev/null
sleep 0.5
FF=$(docker exec "$P-fetcher" sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null || true); echo "$c"; done' | grep -c ffmpeg || true)
[ "${FF:-0}" -eq 0 ] || fail "orphaned ffmpeg after cancel ($FF)"
pass "cancel cleanup"

# Proxy down
docker stop "$P-proxy" >/dev/null
PROXY_DOWN=$(backend submit --id nopx --url http://origin:8000/stream --ports 8000 || true)
echo "$PROXY_DOWN" | grep -q 'proxy-unavailable\|false' || fail "proxy down $PROXY_DOWN"
echo "$PROXY_DOWN" | grep -q '"bytes":0' || fail "proxy down produced pcm $PROXY_DOWN"
docker start "$P-proxy" >/dev/null
sleep 1
pass "proxy failure fail-closed"

# Fetcher restart
docker restart "$P-fetcher" >/dev/null
for i in $(seq 1 40); do docker logs "$P-fetcher" 2>&1 | grep -q 'FETCHER ready' && break; sleep 0.25; done
backend wait --ms 8000 >/dev/null || fail "fetcher restart socket"
AFTER=$(backend submit --id after --url http://origin:8000/stream --ports 8000 || true)
AFTER_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$AFTER")
[ "$AFTER_BYTES" -gt 1000 ] || fail "after restart $AFTER"
pass "fetcher restart"

# Tokens not in argv / fetcher env
CMDLINES=$(docker exec "$P-fetcher" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2>/dev/null; echo; done')
echo "$CMDLINES" | grep -q ffmpeg && fail "ffmpeg still running"
TOKEN_VAL=$(tr -d '\n' < "$TOKEN_FILE")
echo "$CMDLINES" | grep -F -q "$TOKEN_VAL" && fail "token in argv"
ENVIRON_HITS=$(docker exec "$P-fetcher" sh -c 'hits=0; for p in /proc/[0-9]*; do e=$(tr "\0" "\n" < "$p/environ" 2>/dev/null || true); echo "$e" | grep -q "^FETCHER_TOKEN=" && hits=$((hits+1)); echo "$e" | grep -q "^MEDIA_FETCHER_TOKEN=" && hits=$((hits+1)); done; echo $hits')
[ "${ENVIRON_HITS:-0}" -eq 0 ] || fail "token in environ ($ENVIRON_HITS)"
pass "no token in argv/environ"

# Explicit Landlock disable cannot start
NOLL=$(docker run --rm --name "$P-noll" --user node --security-opt=no-new-privileges --read-only --tmpfs /tmp --cap-drop ALL \
  -v "$TOKEN_FILE:/jobs/.token:ro" \
  -e MEDIA_FETCHER_TOKEN_FILE=/jobs/.token -e LL_WRAP=0 \
  "$IMAGE" node /app/fetcher.mjs 2>&1 || true)
echo "$NOLL" | grep -q 'landlock required' || fail "LL_WRAP=0 not refused: $NOLL"
FAKE=$(docker run --rm --user node --security-opt=no-new-privileges --read-only --tmpfs /tmp --cap-drop ALL \
  -v "$TOKEN_FILE:/jobs/.token:ro" \
  -e MEDIA_FETCHER_TOKEN_FILE=/jobs/.token -e LL_WRAP_PATH=/usr/bin/ffmpeg \
  "$IMAGE" node /app/fetcher.mjs 2>&1 || true)
echo "$FAKE" | grep -Eq 'landlock unavailable|landlock wrapper missing|landlock required' || fail "fake wrap not refused: $FAKE"
pass "Landlock disable refused"

echo "GATE C OK"
