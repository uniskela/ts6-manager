#!/usr/bin/env bash
# Network-independent runtime check for the D1 lab image. Uses the rootless Docker context only.
# usage: scripts/container-runtime-test.sh [image]   (default ts6-discord-bridge-lab:d1-r1)
set -u
IMG="${1:-ts6-discord-bridge-lab:d1-r1}"
APP=/app/packages/discord-bridge
fail=0
ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
HARDEN=(--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp)
EVID=(--tmpfs "$APP/evidence:uid=1000,gid=1000")

# 1. default command: native Opus/DAVE smoke, no network, read-only root, unprivileged
out=$(docker run "${HARDEN[@]}" "${EVID[@]}" "$IMG" 2>&1); rc=$?
if [ $rc -eq 0 ] && grep -q 'native-dave' <<<"$out" && ! grep -qiE 'EAI_AGAIN|registry|corepack|ENOTFOUND' <<<"$out"; then
  ok "smoke:deps exits 0 with --network none, read-only root, cap-drop ALL"
else bad "smoke:deps rc=$rc"; printf '%s\n' "$out" | tail -15; fi

sh() { docker run "${HARDEN[@]}" "${EVID[@]}" --entrypoint sh "$IMG" -c "$1" 2>&1; }

# 2. runs as the unprivileged node user
[ "$(sh 'id -u')" = "1000" ] && ok "runs as uid 1000" || bad "not uid 1000"

# 3. vendored code and dependencies are not writable by the runtime user
for p in node_modules .vendor src package.json; do
  if sh "touch $APP/$p/.w 2>/dev/null || touch $APP/$p.w 2>/dev/null; echo rc=\$?" | grep -q 'rc=0'; then bad "$p is writable"; else ok "$p is not writable"; fi
done

# 4. only evidence/ accepts writes
sh "touch $APP/evidence/.w && echo rc=0" | grep -q 'rc=0' && ok "evidence/ is the only writable path" || bad "evidence/ not writable"

# 5. nothing at runtime needs a package manager: entrypoint is the local tsx binary
ep=$(docker inspect --format '{{json .Config.Entrypoint}}' "$IMG")
[ "$ep" = '["./node_modules/.bin/tsx"]' ] && ok "entrypoint is the preinstalled tsx ($ep)" || bad "entrypoint $ep"

# 6. a runtime install attempt cannot reach a registry or write modules (expected to fail)
if sh "cd $APP && ./node_modules/.bin/tsx -e \"import('node:dns').then(d=>d.promises.lookup('registry.npmjs.org')).then(()=>process.exit(0),()=>process.exit(1))\"; echo rc=\$?" | grep -q 'rc=1'; then ok "registry.npmjs.org is unreachable from the container"; else bad "registry reachable"; fi

exit $fail
