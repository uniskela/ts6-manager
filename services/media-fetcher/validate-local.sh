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

P=ts6gatec
cleanup() {
  docker rm -f "$P-backend" "$P-fetcher" "$P-proxy" "$P-world" "$P-noll" "$P-token" >/dev/null 2>&1 || true
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

# Match Compose installer: uid 0, no-new-privileges, cap_drop ALL, only DAC_OVERRIDE+CHOWN.
installer_caps=(--user 0 --security-opt=no-new-privileges --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add CHOWN --read-only)
chmod 644 "$TOKEN_FILE"
docker run --rm "${installer_caps[@]}" -v "$TOKEN_FILE:/src/token:ro" -v "${P}_jobs:/jobs" -v "${P}_ctl:/ctl" \
  -e TOKEN_SRC=/src/token -e TOKEN_DEST=/jobs/.token -e CTL_TOKEN_DEST=/ctl/.ctl-token \
  "$IMAGE" node /app/install-token.mjs >/dev/null 2>&1 && fail "world-readable token installed"
chmod 600 "$TOKEN_FILE"
docker run --rm "${installer_caps[@]}" -v "$TOKEN_FILE:/src/token:ro" -v "${P}_jobs:/jobs" -v "${P}_ctl:/ctl" \
  -e TOKEN_SRC=/src/token -e TOKEN_DEST=/jobs/.token -e CTL_TOKEN_DEST=/ctl/.ctl-token \
  "$IMAGE" node /app/install-token.mjs || fail "compose-cap token install"
TOKEN_STAT=$(docker run --rm -u 1000 -v "${P}_jobs:/jobs" "$IMAGE" stat -c '%a %u %g' /jobs/.token)
[[ "$TOKEN_STAT" = "600 1000 1000" ]] || fail "token stat $TOKEN_STAT"
CTL_STAT=$(docker run --rm -u 1000 -v "${P}_ctl:/ctl" "$IMAGE" stat -c '%a %u %g' /ctl/.ctl-token)
[[ "$CTL_STAT" = "600 1000 1000" ]] || fail "ctl token stat $CTL_STAT"
pass "token+ctl install mode/owner (compose caps)"

# Rotation: reinstall with a new host token under the same caps.
openssl rand -hex 32 > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
docker run --rm "${installer_caps[@]}" -v "$TOKEN_FILE:/src/token:ro" -v "${P}_jobs:/jobs" -v "${P}_ctl:/ctl" \
  -e TOKEN_SRC=/src/token -e TOKEN_DEST=/jobs/.token -e CTL_TOKEN_DEST=/ctl/.ctl-token \
  "$IMAGE" node /app/install-token.mjs || fail "token rotation install"
ROT_STAT=$(docker run --rm -u 1000 -v "${P}_jobs:/jobs" "$IMAGE" stat -c '%a %u' /jobs/.token)
[[ "$ROT_STAT" = "600 1000" ]] || fail "rotated token $ROT_STAT"
pass "token rotation under compose caps"

common=(--user node --security-opt=no-new-privileges --read-only --tmpfs /tmp --cap-drop ALL)

docker run -d --name "$P-world" "${common[@]}" --network "${P}_world" --network-alias origin \
  "$WIMAGE" >/dev/null
for i in $(seq 1 80); do docker logs "$P-world" 2>&1 | grep -q 'WORLD ready' && break; sleep 0.25; done
docker logs "$P-world" 2>&1 | grep -q 'WORLD ready' || fail "world start"
WORLD_TMP=$(docker exec "$P-world" sh -c 'ls -d /tmp/world-* 2>/dev/null | head -1')
[[ -n "$WORLD_TMP" ]] || fail "world tmp dir missing"
docker exec "$P-world" cat "$WORLD_TMP/ca.crt" > "$WORKDIR/ca.crt"
chmod 644 "$WORKDIR/ca.crt"
# Lab CA must live outside /jobs so sandboxed ffmpeg can still read it (/tmp is allow-listed).
docker run --rm -u 0 -v "${P}_jobs:/jobs" "$IMAGE" \
  sh -c 'mkdir -p /jobs/private && echo other-job-secret > /jobs/private/cred && chown -R 1000:1000 /jobs/private && chmod 600 /jobs/private/cred'

docker run -d --name "$P-proxy" "${common[@]}" --network "${P}_fetch" --network-alias media-egress-proxy \
  -v "${P}_ctl:/ctl" \
  -e PROXY_CTL=/ctl/proxy.sock -e PROXY_CTL_TOKEN_FILE=/ctl/.ctl-token -e PROXY_PERMIT_PRIVATE=1 \
  "$IMAGE" node /app/proxy.mjs >/dev/null
docker network connect "${P}_world" "$P-proxy"
for i in $(seq 1 40); do docker logs "$P-proxy" 2>&1 | grep -q 'PROXY ready' && break; sleep 0.25; done
docker logs "$P-proxy" 2>&1 | grep -q 'PROXY ready' || fail "proxy start $(docker logs "$P-proxy" 2>&1 | tail -5)"

# Unauthenticated ctl must not change state (API layer; required on every ABI).
CTL_UNAUTH=$(docker run --rm --user node --network "${P}_fetch" --security-opt=no-new-privileges \
  --read-only --tmpfs /tmp --cap-drop ALL -v "${P}_ctl:/ctl" "$IMAGE" node -e '
const http=require("http");
const req=http.request({socketPath:"/ctl/proxy.sock",path:"/jobs",method:"POST",
  headers:{"content-type":"application/json"}},res=>{
  let b="";res.on("data",c=>b+=c);res.on("end",()=>process.stdout.write(JSON.stringify({status:res.statusCode,body:b})));
});
req.on("error",e=>{process.stdout.write(JSON.stringify({error:e.message}));});
req.end(JSON.stringify({id:"evil",token:"0123456789abcdef",ports:[80],connect:true}));
')
echo "$CTL_UNAUTH" | grep -q '"status":401' || fail "ctl unauth $CTL_UNAUTH"
CTL_SNAP=$(docker run --rm --user node --network "${P}_fetch" --security-opt=no-new-privileges \
  --read-only --tmpfs /tmp --cap-drop ALL -v "${P}_ctl:/ctl" "$IMAGE" node -e '
const http=require("http"); const fs=require("fs");
const tok=fs.readFileSync("/ctl/.ctl-token","utf8").replace(/\s+/g,"");
const req=http.request({socketPath:"/ctl/proxy.sock",path:"/status",method:"GET",
  headers:{authorization:"Bearer "+tok}},res=>{
  let b="";res.on("data",c=>b+=c);res.on("end",()=>process.stdout.write(b));
});
req.on("error",e=>{process.stdout.write(e.message);});
req.end();
')
echo "$CTL_SNAP" | grep -q '"jobs":\[\]' || fail "ctl state after unauth $CTL_SNAP"
pass "ctl unauthenticated register denied"

docker run -d --name "$P-fetcher" "${common[@]}" --network "${P}_fetch" \
  -v "${P}_jobs:/jobs" -v "${P}_ctl:/ctl" \
  -v "$WORKDIR/ca.crt:/tmp/lab-ca.crt:ro" \
  -e JOBS_SOCK=/jobs/jobs.sock -e PROXY_CTL=/ctl/proxy.sock \
  -e PROXY_CTL_TOKEN_FILE=/ctl/.ctl-token \
  -e PROXY_HOST=media-egress-proxy \
  -e MEDIA_FETCHER_TOKEN_FILE=/jobs/.token \
  -e MEDIA_FETCHER_CA_FILE=/tmp/lab-ca.crt \
  -e SSL_CERT_FILE=/tmp/lab-ca.crt \
  -e FETCHER_FFMPEG_LOG=/jobs/ff.err \
  "$IMAGE" node /app/fetcher.mjs >/dev/null
for i in $(seq 1 40); do docker logs "$P-fetcher" 2>&1 | grep -q 'FETCHER ready' && break; sleep 0.25; done
docker logs "$P-fetcher" 2>&1 | grep -q 'FETCHER ready' || fail "fetcher start $(docker logs "$P-fetcher" 2>&1 | tail -5)"

backend() {
  docker run --rm --user node --network "${P}_app" --security-opt=no-new-privileges \
    --read-only --tmpfs /tmp --cap-drop ALL \
    -v "${P}_jobs:/jobs" \
    -v "$DIR/fixtures/client.mjs:/app/client.mjs:ro" \
    -e JOBS_SOCK=/jobs/jobs.sock \
    -e MEDIA_FETCHER_TOKEN_FILE=/jobs/.token \
    "$IMAGE" node /app/client.mjs "$@"
}

backend wait --ms 8000 >/dev/null || fail "job socket"

# Landlock actually enforced
WRAP_CHECK=$(docker exec "$P-fetcher" /usr/local/bin/ll-wrap --check) || fail "ll-wrap --check"
echo "$WRAP_CHECK" | grep -q 'landlock_abi=' || fail "ll-wrap abi line"
echo "$WRAP_CHECK" | grep -q 'landlock_fs=1' || fail "ll-wrap fs line missing: $WRAP_CHECK"
ABI=$(echo "$WRAP_CHECK" | sed -n 's/landlock_abi=//p')
[[ "${ABI:-0}" -ge 4 ]] || fail "ABI $ABI < 4"
RESOLVE_UNIX=$(echo "$WRAP_CHECK" | sed -n 's/landlock_resolve_unix=//p')
pass "Landlock ABI $ABI fs=1 resolve_unix=$RESOLVE_UNIX"

# Sandboxed open() of secrets must fail (FS Landlock).
FS_DENY=$(docker exec "$P-fetcher" /usr/local/bin/ll-wrap 9 sh -c \
  'set +e; cat /jobs/.token >/dev/null 2>/tmp/tok.err; echo token_rc=$?; cat /jobs/private/cred >/dev/null 2>/tmp/cred.err; echo cred_rc=$?; cat /ctl/.ctl-token >/dev/null 2>/tmp/ctl.err; echo ctl_rc=$?; cat /tmp/lab-ca.crt >/dev/null 2>/tmp/ca.err; echo ca_rc=$?')
echo "$FS_DENY" | grep -q 'token_rc=0' && fail "sandboxed read of /jobs/.token: $FS_DENY"
echo "$FS_DENY" | grep -q 'cred_rc=0' && fail "sandboxed read of other job file: $FS_DENY"
echo "$FS_DENY" | grep -q 'ctl_rc=0' && fail "sandboxed read of ctl token: $FS_DENY"
echo "$FS_DENY" | grep -q 'ca_rc=0' || fail "sandboxed CA read should work: $FS_DENY"
pass "FS Landlock denies /jobs and /ctl secrets"

if [[ "${RESOLVE_UNIX:-0}" = "1" ]]; then
  cat > "$WORKDIR/unix-probe.mjs" <<'EOF'
import net from 'node:net';
const s = net.connect('/ctl/proxy.sock');
s.on('connect', () => { process.stdout.write('unix_rc=0\n'); process.exit(0); });
s.on('error', (e) => { process.stdout.write(`unix_rc=${e.errno || 1}\n`); process.exit(0); });
EOF
  docker cp "$WORKDIR/unix-probe.mjs" "$P-fetcher:/tmp/unix-probe.mjs"
  UNIX_DENY=$(docker exec "$P-fetcher" /usr/local/bin/ll-wrap 9 node /tmp/unix-probe.mjs || true)
  echo "$UNIX_DENY" | grep -q 'unix_rc=0' && fail "ABI9+ unix connect allowed: $UNIX_DENY"
  pass "ABI9+ pathname unix connect denied"
else
  pass "ABI $ABI < 9: unix connect not claimed blocked by Landlock (ctl API auth covers it)"
fi

# Networks / ports / no docker.sock
FETC_NETS=$(docker inspect "$P-fetcher" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
echo "$FETC_NETS" | grep -q "${P}_fetch" || fail "fetcher not on fetch net"
echo "$FETC_NETS" | grep -q "${P}_app" && fail "fetcher joined app net"
docker inspect "$P-fetcher" --format '{{json .HostConfig.PortBindings}}' | grep -q '{}' || fail "fetcher published ports"
docker inspect "$P-proxy" --format '{{json .HostConfig.PortBindings}}' | grep -q '{}' || fail "proxy published ports"
docker inspect "$P-fetcher" --format '{{json .HostConfig.Binds}}' | grep -q docker.sock && fail "docker.sock"
docker inspect "$P-fetcher" --format '{{.HostConfig.Privileged}} {{.HostConfig.CapAdd}}' | grep -qi true && fail "privileged/caps"
SOCK_MODE=$(docker exec "$P-fetcher" stat -c '%a' /jobs/jobs.sock)
[[ "$SOCK_MODE" = "660" ]] || fail "jobs.sock mode $SOCK_MODE"
pass "topology and socket mode $SOCK_MODE"

# Auth
UNAUTH=$(backend unauth || true)
echo "$UNAUTH" | grep -q unauthorized || fail "unauth $UNAUTH"
pass "unix auth"

# PCM paths
HLS=$(backend submit --id legit --url https://origin:8443/live.m3u8 --ports 8443 || true)
echo "HLS $HLS"
HLS_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$HLS")
if [[ "$HLS_BYTES" -le 1000 ]]; then
  echo "ffmpeg-log:"; docker exec "$P-fetcher" sh -c 'cat /jobs/ff.err 2>/dev/null | tail -40' || true
  docker logs "$P-proxy" 2>&1 | tail -20 || true
  fail "hls bytes $HLS_BYTES"
fi
pass "HLS PCM $HLS_BYTES"

HTTP=$(backend submit --id http1 --url http://origin:8000/stream --ports 8000 || true)
HTTP_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$HTTP")
[[ "$HTTP_BYTES" -gt 1000 ]] || fail "http iceast $HTTP"
pass "HTTP Icecast $HTTP_BYTES"

HTTPS=$(backend submit --id https1 --url https://origin:8443/stream --ports 8443 || true)
HTTPS_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$HTTPS")
[[ "$HTTPS_BYTES" -gt 1000 ]] || fail "https iceast $HTTPS"
pass "HTTPS Icecast $HTTPS_BYTES"

HOP=$(backend submit --id hop1 --url http://origin:8000/https-hop.m3u8 --ports 8000,8443 || true)
HOP_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$HOP")
[[ "$HOP_BYTES" -eq 0 ]] || fail "HTTP-start HTTPS hop leaked $HOP"
pass "HTTP-start CONNECT denied"

docker exec "$P-fetcher" sh -c ': > /jobs/ff.err' || true
BADCERT=$(backend submit --id badcert --url https://origin:8080/stream --ports 8080 || true)
BADCERT_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$BADCERT")
[[ "$BADCERT_BYTES" -eq 0 ]] || fail "untrusted HTTPS initial leaked $BADCERT"
BADCERT_LOG=$(docker exec "$P-fetcher" sh -c 'cat /jobs/ff.err 2>/dev/null || true')
echo "$BADCERT_LOG" | grep -Ei 'certificate|tls|gnutls|verify|self[- ]signed' >/dev/null \
  || fail "untrusted HTTPS initial not a cert error: $BADCERT_LOG"
pass "untrusted HTTPS initial blocked (cert)"

BADHOP=$(backend submit --id badhop --url https://origin:8443/https-bad.m3u8 --ports 8443,8080 || true)
BADHOP_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$BADHOP")
[[ "$BADHOP_BYTES" -eq 0 ]] || fail "untrusted HTTPS hop leaked $BADHOP"
pass "untrusted HTTPS-start hop blocked"

HTTPBAD=$(backend submit --id httpbad --url http://origin:8000/https-bad.m3u8 --ports 8000,8080 || true)
HTTPBAD_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$HTTPBAD")
[[ "$HTTPBAD_BYTES" -eq 0 ]] || fail "HTTP-start untrusted HTTPS leaked $HTTPBAD"
pass "HTTP-start untrusted HTTPS denied"

FILETOK=$(backend submit --id filetok --url https://origin:8443/file-token.m3u8 --ports 8443 || true)
FILETOK_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$FILETOK")
[[ "$FILETOK_BYTES" -eq 0 ]] || fail "file token playlist leaked $FILETOK"
UNIXCTL=$(backend submit --id unixctl --url https://origin:8443/unix-ctl.m3u8 --ports 8443 || true)
UNIXCTL_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$UNIXCTL")
[[ "$UNIXCTL_BYTES" -eq 0 ]] || fail "unix ctl playlist leaked $UNIXCTL"
pass "ffmpeg file/unix playlist blocked"

BADPORT=$(backend submit --id ssh1 --url http://origin:8000/stream --ports 22 || true)
echo "$BADPORT" | grep -q bad-ports || fail "unclamped ports $BADPORT"
pass "ports clamped"

# Original httpproxy HLS bypass
BYPASS=$(backend submit --id bypass --url https://origin:8443/bypass.m3u8 --ports 8443 || true)
BYPASS_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$BYPASS")
[[ "$BYPASS_BYTES" -eq 0 ]] || fail "bypass leaked $BYPASS"
TRAP=$(docker run --rm --network "${P}_world" "$IMAGE" node -e '
const http=require("http"); http.get("http://origin:9500/",res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>process.stdout.write(b));});
')
echo "$TRAP" | grep -F -q '"trapPeers":[]' || fail "trap peers $TRAP"
pass "httpproxy HLS bypass blocked"

# Cross-job + concurrent allowlists
backend hold-cancel --id jobB --url http://origin:8000/hold --ms 25000 --ports 8000 > "$WORKDIR/b.json" &
for i in $(seq 1 40); do grep -q shimPort "$WORKDIR/b.json" 2>/dev/null && break; sleep 0.2; done
BPORT=$(node -e "const t=require('fs').readFileSync(process.argv[1],'utf8'); const m=t.match(/\"shimPort\":(\\d+)/); if(!m) process.exit(2); process.stdout.write(m[1]);" "$WORKDIR/b.json")
[[ -n "$BPORT" ]] || fail "B shim $WORKDIR/b.json"
docker exec "$P-world" sh -c "printf '%s\n' '127.0.0.1:${BPORT}' > '${WORLD_TMP}/cross-target'"
A_CROSS=$(backend submit --id jobA --url https://origin:8443/cross.m3u8 --ports 8443 || true)
A2=$(backend submit --id jobA2 --url "httpproxy://127.0.0.1:${BPORT}/http://origin:8000/stream" --ports 8443 || true)
A2_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.bytes||0))" "$A2")
[[ "$A2_BYTES" -eq 0 ]] || fail "cross-job inherit $A2"
BST=$(backend status || true)
echo "$BST" | grep -q jobB || fail "B gone during A2 $BST"
DUP=$(backend submit --id jobB --url http://origin:8000/stream --ports 8000 || true)
echo "$DUP" | grep -q duplicate-job || fail "duplicate id $DUP"
pass "cross-job shim blocked (B=$BPORT A2 bytes=$A2_BYTES)"

# Cancel / no leftover ffmpeg (jobB hold from the cross-job test must be gone first)
backend cancel --id jobB >/dev/null || true
wait || true
backend hold-cancel --id hold1 --url http://origin:8000/hold --ms 800 --ports 8000 >/dev/null
sleep 0.5
FF=$(docker exec "$P-fetcher" sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null || true); echo "$c"; done' | grep -c ffmpeg || true)
[[ "${FF:-0}" -eq 0 ]] || fail "orphaned ffmpeg after cancel ($FF)"
pass "cancel cleanup"

# Abrupt client destroy mid-stream (/stop): fetcher must stay up; next job must work.
ABRUPT=$(backend abrupt-stop --id abrupt1 --next after-abrupt \
  --url http://origin:8000/hold --next-url http://origin:8000/stream --ms 600 --ports 8000 || true)
echo "$ABRUPT" | grep -q '"ok":true' || fail "abrupt-stop response $ABRUPT"
AFTER_ABRUPT_BYTES=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.next&&j.next.bytes||0))" "$ABRUPT")
[[ "$AFTER_ABRUPT_BYTES" -gt 0 ]] || fail "post-abrupt job failed $ABRUPT"
FF2=$(docker exec "$P-fetcher" sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null || true); echo "$c"; done' | grep -c ffmpeg || true)
[[ "${FF2:-0}" -eq 0 ]] || fail "orphaned ffmpeg after abrupt-stop ($FF2)"
docker logs "$P-fetcher" 2>&1 | grep -E 'Unhandled .error. event|FETCHER client disconnect' | tail -5
docker logs "$P-fetcher" 2>&1 | grep -q 'Unhandled' && fail "fetcher unhandled after abrupt-stop"
docker logs "$P-fetcher" 2>&1 | grep -q 'FETCHER client disconnect' || fail "missing disconnect log after abrupt-stop"
pass "abrupt-stop survives ($AFTER_ABRUPT_BYTES pcm next)"

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
[[ "$AFTER_BYTES" -gt 1000 ]] || fail "after restart $AFTER"
pass "fetcher restart"

# Tokens not in argv / fetcher env
CMDLINES=$(docker exec "$P-fetcher" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2>/dev/null; echo; done')
echo "$CMDLINES" | grep -q ffmpeg && fail "ffmpeg still running"
TOKEN_VAL=$(tr -d '\n' < "$TOKEN_FILE")
echo "$CMDLINES" | grep -F -q "$TOKEN_VAL" && fail "token in argv"
CTL_VAL=$(docker exec "$P-fetcher" sh -c "tr -d '\\n' < /ctl/.ctl-token")
echo "$CMDLINES" | grep -F -q "$CTL_VAL" && fail "ctl token in argv"
ENVIRON_HITS=$(docker exec "$P-fetcher" sh -c 'hits=0; for p in /proc/[0-9]*; do e=$(tr "\0" "\n" < "$p/environ" 2>/dev/null || true); echo "$e" | grep -q "^FETCHER_TOKEN=" && hits=$((hits+1)); echo "$e" | grep -q "^MEDIA_FETCHER_TOKEN=" && hits=$((hits+1)); done; echo $hits')
[[ "${ENVIRON_HITS:-0}" -eq 0 ]] || fail "token in environ ($ENVIRON_HITS)"
pass "no token in argv/environ"

# Explicit Landlock disable cannot start
NOLL=$(docker run --rm --name "$P-noll" --user node --security-opt=no-new-privileges --read-only --tmpfs /tmp --cap-drop ALL \
  -v "${P}_jobs:/jobs" -v "${P}_ctl:/ctl" \
  -e MEDIA_FETCHER_TOKEN_FILE=/jobs/.token -e PROXY_CTL_TOKEN_FILE=/ctl/.ctl-token -e LL_WRAP=0 \
  "$IMAGE" node /app/fetcher.mjs 2>&1 || true)
echo "$NOLL" | grep -q 'landlock required' || fail "LL_WRAP=0 not refused: $NOLL"
FAKE=$(docker run --rm --user node --security-opt=no-new-privileges --read-only --tmpfs /tmp --cap-drop ALL \
  -v "${P}_jobs:/jobs" -v "${P}_ctl:/ctl" \
  -e MEDIA_FETCHER_TOKEN_FILE=/jobs/.token -e PROXY_CTL_TOKEN_FILE=/ctl/.ctl-token -e LL_WRAP_PATH=/usr/bin/ffmpeg \
  "$IMAGE" node /app/fetcher.mjs 2>&1 || true)
echo "$FAKE" | grep -Eq 'landlock unavailable|landlock wrapper missing|landlock required' || fail "fake wrap not refused: $FAKE"
pass "Landlock disable refused"

echo "GATE C OK"
