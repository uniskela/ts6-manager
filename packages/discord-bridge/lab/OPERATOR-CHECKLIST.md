# D1 operator checklist (start / stop — no secrets)

Pinned candidate: draft [#504](https://github.com/uniskela/ts6-manager/pull/504) tip `46ce40c9` (verify with `git rev-parse HEAD` before a session).  
Do **not** pass `--confirm` until the owner authorises a live run.

## Isolation (required before start)

| Check | Pass |
|-------|------|
| Worktree / checkout is `#504` tip | `git rev-parse HEAD` = `46ce40c9…` |
| Lab image built | `ts6-discord-bridge-lab:d1-46ce40c9` |
| Host publish is **not** `0.0.0.0` / `*` | `d1-ts-lab.sh status` → `publish_wildcard=no` |
| INT-TEST / other stacks undisturbed | If host UDP `19987` is taken (e.g. `ts6-discord-int-teamspeak`), use `D1_TS_LAB_HOST_PORT=19989` (or another free port) |
| Network not `--internal` | `ts_net_internal=no` (Discord must reach out) |
| `lab/.env` mode `0600` | Presence prints SET/MISSING only |

## One-time prep (offline)

```bash
cd packages/discord-bridge
CI=1 pnpm install --frozen-lockfile --ignore-workspace
pnpm run typecheck && pnpm test && pnpm run smoke:deps

# From repo root:
docker build -f packages/discord-bridge/lab/Dockerfile -t ts6-discord-bridge-lab:d1-46ce40c9 .
packages/discord-bridge/scripts/container-runtime-test.sh ts6-discord-bridge-lab:d1-46ce40c9
```

## Disposable TeamSpeak lab

```bash
# Prefer Tailscale or loopback publish; never wildcard.
# If 19987 is busy, pick another host port:
D1_TS_LAB_HOST_PORT=19989 packages/discord-bridge/scripts/d1-ts-lab.sh start
D1_TS_LAB_HOST_PORT=19989 packages/discord-bridge/scripts/d1-ts-lab.sh status

# Handshake from the published host IP (Tailscale if loopback was skipped):
TS_LAB_HOST=<tailscale-or-127.0.0.1> TS_LAB_PORT=19989 \
  packages/discord-bridge/node_modules/.bin/tsx packages/discord-bridge/src/lab/ts-handshake.ts
```

Bridge container uses Docker DNS `D1_TS_HOST=d1-ts6-lab` and in-network port `9987` (not the host publish port).

## Presence only (no Discord connect)

```bash
# Laboratory A–D runner:
D1_ENV_FILE=packages/discord-bridge/lab/.env \
  packages/discord-bridge/scripts/run-live-container.sh
# Expect every required key SET; D1_DAVE_SINGLE_ATTEMPT SET for A/B/D.

# Optional private-beta runner presence:
D1_ENV_FILE=packages/discord-bridge/lab/.env \
  packages/discord-bridge/scripts/private-beta.sh check
```

For A/B/D: `D1_DAVE_SINGLE_ATTEMPT=1`. For C only: `--allow-recovery` (unset single-attempt).

## Live start (owner GO only)

```bash
D1_LAB_IMAGE=ts6-discord-bridge-lab:d1-46ce40c9 \
D1_DAVE_SINGLE_ATTEMPT=1 \
D1_ENV_FILE=packages/discord-bridge/lab/.env \
  packages/discord-bridge/scripts/run-live-container.sh --confirm --single-attempt
```

Stdin: `status` | `mark <id> pass|fail <note>` | `kill-receiver` (C only) | `write` | `quit`.  
Marks: see `ACCEPTANCE.md`.

## Stop / rollback / cleanup

```bash
# End live runner: quit on stdin (writes evidence under lab/evidence/ mode 0700).

# Private-beta stop (keeps image + evidence; does not remove TS lab):
packages/discord-bridge/scripts/private-beta.sh stop

# Roll back private-beta to a previous local full SHA (no pull):
packages/discord-bridge/scripts/private-beta.sh rollback <previous-full-sha>

# Tear down disposable TS lab only (removes container, volume, network):
D1_TS_LAB_HOST_PORT=19989 packages/discord-bridge/scripts/d1-ts-lab.sh stop
```

Emergency: `quit` / `private-beta.sh stop` → revoke Discord bot tokens if compromised → leave mapped Discord channel → do not touch production TS / `#609`.

## Health notes (do not invent live PASS)

- `health=parked` + `daveReady=false` with **bots only** in Discord = expected idle park (audio fail-closed).
- `health=fail-closed` + `daveReady=false` with a **human** present = real problem; stop the run; do not claim DAVE ready from offline tests.
