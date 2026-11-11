#!/usr/bin/env bash
# Offline INT media-fetcher + backend stack check (no Discord tunnel / interactions).
#
# Port safety: never kills an arbitrary :3011/:9800 listener. If a verified
# disposable INT-TEST *host* backend holds :3011, set STOP_INT_HOST_BACKEND=1
# to stop only that process. Otherwise free the port yourself and rerun.
# Cleanup: docker compose -p ts6-discord-int-media … down (no -v) — does not stop
# docker-compose.discord-int-ts.yml (project ts6-discord-int) or production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export ROOT
# shellcheck source=discord-int-media-fetcher-compose.sh
source "$ROOT/scripts/discord-int-media-fetcher-compose.sh"
COMPOSE=(discord_int_media_compose)
ENV_FILE="$ROOT/.env.discord-integration-test"
SEED="${MEDIA_FETCHER_SEED_TOKEN_FILE:-$ROOT/.media-fetcher-token-int}"
KEEP="${KEEP:-0}"

die() { echo "stack-check FAIL: $*" >&2; exit 1; }
ok() { echo "stack-check OK: $*"; }

cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    echo "KEEP=1 — leaving stack up"
    return
  fi
  # Tear down only project ts6-discord-int-media. No -v (keeps jobs volume +
  # never deletes discord-int-test.db). Does not stop ts6-discord-int TS.
  "${COMPOSE[@]}" --profile int-backend --profile ipc-check down --remove-orphans || true
}
trap cleanup EXIT

discord_int_media_assert_project_safe || die "compose project isolation check failed"
[[ -f "$ENV_FILE" ]] || die "missing .env.discord-integration-test"

# Resolve DB/music dirs from gitignored INT env. Never rewrite production paths.
# Refuse to invent/overwrite SIDECAR_SECRET here — operator must set it explicitly.
eval "$(ROOT="$ROOT" python3 - <<'PY'
from pathlib import Path
import os
root = Path(os.environ["ROOT"])
env_path = root / ".env.discord-integration-test"
vals = {}
for line in env_path.read_text().splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    vals[k] = v.strip().strip('"').strip("'")
db = vals.get("DATABASE_URL", "")
if not db.startswith("file:"):
    raise SystemExit("DATABASE_URL must be a file: URL")
db_path = Path(db[5:])
if not db_path.is_file() or db_path.name != "discord-int-test.db":
    raise SystemExit("expected existing discord-int-test.db")
# Refuse obvious production DB basenames even if somehow mis-pointed.
if db_path.name == "ts6webui.db":
    raise SystemExit("refusing ts6webui.db — INT stack uses discord-int-test.db only")
music = Path(vals["MUSIC_DIR"]) if vals.get("MUSIC_DIR") else root / "packages/backend/data/discord-int-music"
secret = vals.get("SIDECAR_SECRET", "").strip()
if len(secret) < 16:
    raise SystemExit("SIDECAR_SECRET missing/short in .env.discord-integration-test — set it manually (script will not write secrets)")
print(f"export DISCORD_INT_DB_DIR={str(db_path.parent)!r}")
print(f"export DISCORD_INT_MUSIC_DIR={str(music)!r}")
print(f"export DISCORD_INT_DB_INO={db_path.stat().st_ino}")
print(f"export DISCORD_INT_DB_SIZE={db_path.stat().st_size}")
PY
)"

export MEDIA_FETCHER_SEED_TOKEN_FILE="$SEED"
export TS6_DISCORD_INT_INTERACTIONS="${TS6_DISCORD_INT_INTERACTIONS:-false}"
export TS6_DISCORD_INT_LIVE="${TS6_DISCORD_INT_LIVE:-false}"

if [[ ! -f "$SEED" ]]; then
  umask 077
  openssl rand -hex 32 >"$SEED"
fi
chmod 600 "$SEED" || true
mkdir -p "$DISCORD_INT_MUSIC_DIR"

echo "==> activation gates (offline unit tests)"
(cd "$ROOT/packages/backend" && pnpm exec node --import tsx --test src/startup-isolation.test.ts)

echo "==> compose: default interactions OFF; SIDECAR_SECRET non-blank"
export TS6_DISCORD_INT_INTERACTIONS=false
export TS6_DISCORD_INT_LIVE=false
cfg_off="$("${COMPOSE[@]}" --profile int-backend config)"
printf '%s' "$cfg_off" | python3 -c '
import sys, re
text = sys.stdin.read()
if "DISCORD_INTERACTIONS_ENABLED: \"false\"" not in text and "DISCORD_INTERACTIONS_ENABLED: false" not in text:
    raise SystemExit("expected DISCORD_INTERACTIONS_ENABLED false in default config")
if "TS6_ISOLATED_LIVE_INTERACTIONS: \"false\"" not in text and "TS6_ISOLATED_LIVE_INTERACTIONS: false" not in text:
    raise SystemExit("expected TS6_ISOLATED_LIVE_INTERACTIONS false in default config")
vals = re.findall(r"SIDECAR_SECRET:\s*(\S+)", text)
if not vals:
    raise SystemExit("SIDECAR_SECRET missing from compose config")
for v in vals:
    v = v.strip().strip("\"").strip("'\''")
    if len(v) < 16:
        raise SystemExit("SIDECAR_SECRET blank/short after compose interpolation")
print("stack-check OK: compose defaults interactions OFF; SIDECAR_SECRET set (omitted)")
'

# Supervised knobs resolve without applying live Discord
export TS6_DISCORD_INT_INTERACTIONS=true
export TS6_DISCORD_INT_LIVE=true
cfg_on="$("${COMPOSE[@]}" --profile int-backend config)"
echo "$cfg_on" | grep -E 'DISCORD_INTERACTIONS_ENABLED:\s*"?true' >/dev/null \
  || echo "$cfg_on" | grep -q 'DISCORD_INTERACTIONS_ENABLED: true' \
  || die "supervised compose knobs did not enable DISCORD_INTERACTIONS_ENABLED"
ok "supervised compose knobs can enable interactions (not started live)"
# Restore fail-closed for the actual stack run
export TS6_DISCORD_INT_INTERACTIONS=false
export TS6_DISCORD_INT_LIVE=false

# Port occupancy: never kill arbitrary listeners. Only a positively identified
# disposable INT-TEST host backend may be stopped, and only with explicit approval.
is_disposable_int_host_backend() {
  local pid="$1"
  local cmd cwd envfile
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ -n "$cmd" ]] || return 1
  # Refuse production-ish images / compose project names in the command line.
  if echo "$cmd" | grep -Eqi 'ts6webui|ghcr\.io/uniskela/ts6-manager/(backend|sidecar)|docker-compose\.yml'; then
    return 1
  fi
  # Positive INT markers on argv (tsx/node host INT backend from this worktree).
  if echo "$cmd" | grep -Eq 'discord-int-test|\.env\.discord-integration-test|TS6_ISOLATED_INTEGRATION'; then
    return 0
  fi
  # Or cwd / environ points at the INT env / isolated db basename.
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ -n "$cwd" ]] && echo "$cwd" | grep -Eq 'integration-discord-bridge-commands-radio|discord-int'; then
    if echo "$cmd" | grep -Eq 'packages/backend|tsx|node .*dist/index'; then
      return 0
    fi
  fi
  if [[ -r "/proc/$pid/environ" ]]; then
    envfile="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null || true)"
    if echo "$envfile" | grep -Eq '^TS6_ISOLATED_INTEGRATION=(1|true)$' \
      && echo "$envfile" | grep -Eq 'discord-int-test\.db'; then
      return 0
    fi
  fi
  return 1
}

echo "==> ensure host :3011 / :9800 free (no blind kills)"
if ss -ltnp 2>/dev/null | grep -q '127.0.0.1:3011'; then
  pid="$(ss -ltnp 2>/dev/null | sed -n 's/.*127.0.0.1:3011.*pid=\([0-9]\+\).*/\1/p' | head -1)"
  [[ -n "$pid" ]] || die "port 3011 busy but pid unknown — aborting (will not kill)"
  if ! is_disposable_int_host_backend "$pid"; then
    die "port 3011 busy (pid=$pid) and not verified as disposable INT-TEST backend — stop it yourself, then rerun"
  fi
  if [[ "${STOP_INT_HOST_BACKEND:-0}" != "1" ]]; then
    die "port 3011 held by verified INT-TEST host backend (pid=$pid). Re-run with STOP_INT_HOST_BACKEND=1 to stop only that process, or free the port yourself"
  fi
  echo "STOP_INT_HOST_BACKEND=1 — stopping verified INT-TEST host backend pid=$pid"
  kill "$pid" || die "could not stop verified INT pid $pid"
  for _ in $(seq 1 40); do
    ss -ltnp 2>/dev/null | grep -q '127.0.0.1:3011' || break
    sleep 0.25
  done
  ss -ltnp 2>/dev/null | grep -q '127.0.0.1:3011' && die "port 3011 still busy after verified INT stop"
fi
if ss -ltnp 2>/dev/null | grep -q '127.0.0.1:9800'; then
  die "port 9800 busy — aborting (will not kill). Free INT sidecar / host sidecar yourself, then rerun"
fi

echo "==> disposable TS WebQuery"
python3 - <<'PY'
import socket, sys
s = socket.socket(); s.settimeout(2)
try:
    if s.connect_ex(("127.0.0.1", 11080)) != 0:
        raise SystemExit("WebQuery 127.0.0.1:11080 not reachable — start docker-compose.discord-int-ts.yml")
finally:
    s.close()
print("stack-check OK: WebQuery 127.0.0.1:11080 reachable")
PY

# Host binding / identity checks against the intended DB file (before container mutates)
python3 - <<PY
import sqlite3
from pathlib import Path
db = Path("$DISCORD_INT_DB_DIR") / "discord-int-test.db"
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
bindings = list(con.execute("select instanceId, guildId from DiscordGuildBinding"))
bots = list(con.execute("select id, name, voicePort from MusicBot"))
servers = list(con.execute("select id, name, host, webqueryPort from TsServerConfig"))
con.close()
assert bindings, "no DiscordGuildBinding rows"
assert all(b[0] == "discord-int-test" for b in bindings), bindings
assert servers and all(s[2] == "127.0.0.1" for s in servers), servers
assert not any("d1" in (b[1] or "").lower() and "prod" in (b[1] or "").lower() for b in bots)
print("stack-check OK: INT guild binding + loopback TS config on existing db")
PY

echo "==> start INT stack project=$DISCORD_INT_MEDIA_COMPOSE_PROJECT (STACK_BUILD=1 to force --build)"
# Snapshot foreign projects before up (must remain after cleanup)
FOREIGN_BEFORE="$(docker ps -a --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}' \
  | awk -F'\t' -v p="$DISCORD_INT_MEDIA_COMPOSE_PROJECT" '$2!="" && $2!=p {print}' | sort)"
UP_ARGS=(--profile int-backend up -d)
if [[ "${STACK_BUILD:-0}" == "1" ]]; then
  UP_ARGS=(--profile int-backend up --build -d)
fi
"${COMPOSE[@]}" "${UP_ARGS[@]}"
discord_int_media_assert_running_labels || die "INT container project labels incorrect"

echo "==> wait for backend health"
ready=0
for _ in $(seq 1 120); do
  if curl -fsS -m 2 "http://127.0.0.1:3011/api/health" >/tmp/ts6-int-health.json 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != "1" ]]; then
  "${COMPOSE[@]}" --profile int-backend logs --no-color --tail 100 backend sidecar media-fetcher || true
  die "backend health not ready"
fi
python3 - <<'PY'
import json
h = json.load(open("/tmp/ts6-int-health.json"))
assert h.get("status") == "ok", h
print("stack-check OK: /api/health", h.get("status"), "version", h.get("version"))
PY

echo "==> same db file (inode) still present"
python3 - <<PY
from pathlib import Path
db = Path("$DISCORD_INT_DB_DIR") / "discord-int-test.db"
st = db.stat()
assert st.st_ino == int("$DISCORD_INT_DB_INO"), (st.st_ino, int("$DISCORD_INT_DB_INO"))
print("stack-check OK: db inode unchanged", st.st_ino, "size", st.st_size)
PY

echo "==> backend container IPC to fetcher"
docker exec ts6-discord-int-backend node -e '
const fs=require("fs"); const net=require("net");
const tokenPath="/jobs/.token"; const sockPath="/jobs/jobs.sock";
const st=fs.statSync(tokenPath);
if ((st.mode & 0o777) !== 0o600) { console.error("bad token mode"); process.exit(1); }
const token=fs.readFileSync(tokenPath,"utf8").replace(/\s+/g,"");
if (token.length < 16) process.exit(1);
fs.accessSync(sockPath, fs.constants.W_OK);
function once(msg){return new Promise((resolve,reject)=>{const s=net.connect(sockPath);const t=setTimeout(()=>reject(new Error("timeout")),5000);let b="";s.on("connect",()=>s.write(JSON.stringify(msg)+"\n"));s.on("data",c=>{b+=c.toString();const i=b.indexOf("\n");if(i<0)return;clearTimeout(t);s.end();resolve(JSON.parse(b.slice(0,i)));});s.on("error",reject);});}
(async()=>{
  const a=await once({op:"status",token}); if(a.ok!==true) throw new Error(JSON.stringify(a));
  const b=await once({op:"status",token:"0".repeat(32)}); if(b.ok!==false||b.error!=="unauthorized") throw new Error(JSON.stringify(b));
  const c=await once({op:"submit",token,url:"not-a-url",ports:[80,443]}); if(c.ok!==false||c.error!=="bad url") throw new Error(JSON.stringify(c));
  console.log("backend-ipc PASS");
})().catch(e=>{console.error(e); process.exit(1);});
'

echo "==> sidecar + bind address checks"
curl -fsS -m 2 "http://127.0.0.1:9800/health" >/tmp/ts6-int-sidecar.json || die "sidecar health failed"
ok "sidecar health on 127.0.0.1:9800"
if ss -ltn | grep -qE '0\.0\.0\.0:3011|[[:space:]]\*:3011'; then
  die "backend listening on non-loopback 3011"
fi
ss -ltn | grep -q '127.0.0.1:3011' || die "backend missing on 127.0.0.1:3011"
ok "backend on 127.0.0.1:3011 only (path filter reachable)"

echo "==> backend container → TS WebQuery via rootless host network"
docker exec ts6-discord-int-backend node -e "
const net=require('net');
const s=net.connect({host:'127.0.0.1',port:11080});
const t=setTimeout(()=>{console.error('timeout');process.exit(1)},3000);
s.on('connect',()=>{clearTimeout(t);s.end();console.log('backend-to-webquery PASS');});
s.on('error',e=>{console.error(e);process.exit(1);});
"

FOREIGN_AFTER_UP="$(docker ps -a --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}' \
  | awk -F'\t' -v p="$DISCORD_INT_MEDIA_COMPOSE_PROJECT" '$2!="" && $2!=p {print}' | sort)"
if [[ "$FOREIGN_BEFORE" != "$FOREIGN_AFTER_UP" ]]; then
  die "foreign compose containers changed unexpectedly during INT up"
fi
if docker inspect ts6-discord-int-teamspeak >/dev/null 2>&1; then
  ts_proj="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' ts6-discord-int-teamspeak)"
  [[ "$ts_proj" == "ts6-discord-int" ]] || die "INT TS container project label drifted: $ts_proj"
  ok "disposable TS remains project ts6-discord-int (untouched)"
fi

if [[ "$KEEP" != "1" ]]; then
  echo "==> cleanup project=$DISCORD_INT_MEDIA_COMPOSE_PROJECT only (no -v)"
  "${COMPOSE[@]}" --profile int-backend --profile ipc-check down --remove-orphans
  KEEP=1 # prevent EXIT trap from re-running down
  FOREIGN_AFTER_DOWN="$(docker ps -a --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}' \
    | awk -F'\t' -v p="$DISCORD_INT_MEDIA_COMPOSE_PROJECT" '$2!="" && $2!=p {print}' | sort)"
  if [[ "$FOREIGN_BEFORE" != "$FOREIGN_AFTER_DOWN" ]]; then
    die "down --remove-orphans affected a foreign Compose project"
  fi
  for c in "${DISCORD_INT_MEDIA_OWNED_CONTAINERS[@]}"; do
    if docker inspect "$c" >/dev/null 2>&1; then
      die "owned container '$c' still present after project down"
    fi
  done
  ok "cleanup removed only ts6-discord-int-media containers"
fi
ok "offline stack validation complete (not audible radio acceptance)"
