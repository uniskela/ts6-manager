# Bridge-D1 restricted private beta

**Experimental. Opt-in. Not public. Not a production replacement.**

This is a labelled runtime for ongoing private conversations with a small authorised group. It is not the laboratory stdin procedure in `src/lab/live.ts` / `lab/ACCEPTANCE.md`.

Owner decision: GO for a restricted private beta only. Still **NO-GO** for public distribution, production TeamSpeak, merging PR #504, publishing a bridge image, or starting D2–D6.

Acceptance tests A–D may be run in controlled sessions during this beta. Keep those PASS/FAIL files separate from the usage counters written here.

## Compose / runtime

| Item | Value |
|---|---|
| Mode | `D1_RUNTIME_MODE=private-beta` (required; laboratory runner refuses this value) |
| Compose | `lab/docker-compose.private-beta.yml` (project `d1-private-beta`) |
| Image | `ts6-discord-bridge-private-beta:<full-git-sha>` — local build only, never push |
| Secrets | `lab/.env` mode `0600`, bind-mounted via `env_file`. Not in the image |
| Ports | none on the bridge. TeamSpeak stays on the existing disposable lab (loopback UDP 19987) |
| Restart | `restart: "no"`. No compose/container restart loop |
| Limits | 1 CPU, 512 MB, `cap-drop ALL`, read-only root, `no-new-privileges` |
| Logs | json-file, 4 MB × 5 files |
| Status | `scripts/private-beta.sh status` reads `lab/evidence/private-beta-status.json` (no stdin) |
| TeamSpeak | disposable `d1-ts-lab` only. Do not use the production server |

DAVE enforcement, receive-generation fencing, human admission and the 3-per-60s rebuild budget are the same as the laboratory runtime. The container is not restarted when that budget is exhausted.

## Build and start

Do not start this from CI. Do not deploy from this document.

```bash
# 1. Disposable TS6 lab (not production)
packages/discord-bridge/scripts/d1-ts-lab.sh start

# 2. Secrets: copy lab/env.private-beta.example → lab/.env, chmod 0600, fill locally.
#    Add D1_RUNTIME_MODE=private-beta to an existing 0600 lab/.env if you already have one.

# 3. Presence only (SET/MISSING). No Discord connections.
packages/discord-bridge/scripts/private-beta.sh check

# 4. Local image pinned to this checkout
packages/discord-bridge/scripts/private-beta.sh build

# 5. After the operator names the session and participants are present:
packages/discord-bridge/scripts/private-beta.sh up --confirm

# 6. Non-interactive status
packages/discord-bridge/scripts/private-beta.sh status
packages/discord-bridge/scripts/private-beta.sh logs
```

Phase 1 (first supervised session): set `D1_DAVE_SINGLE_ATTEMPT=1` in `lab/.env` so the process does not reconnect. Phase 2: unset it to exercise the existing 3/60s budget. Leave `restart: "no"` in both phases.

Stop:

```bash
packages/discord-bridge/scripts/private-beta.sh stop
# optional, removes only the disposable TS lab:
packages/discord-bridge/scripts/d1-ts-lab.sh stop
```

`stop` keeps the local image and `lab/evidence/` (mode `0700`). It does not touch production compose, GHCR, Docker Hub, or stable manager images.

## Health and recovery

| Signal | Where | Meaning |
|---|---|---|
| `health=ok` | status file | running, one receiver, DAVE ready, no duplicate receivers |
| `health=degraded` | status file | scheduled reconnect, decrypt error, or recovery count > 0 |
| `health=fail-closed` | status file | no receiver, DAVE not ready, duplicate receiver, or stopping |
| container exit | `docker inspect` | process ended; it will **not** come back (`restart: no`) |

On encryption loss the bridge still fails closed (no plaintext). Bounded in-process reconnects happen only when `D1_DAVE_SINGLE_ATTEMPT` is unset. There is no outer restart loop.

SIGTERM/SIGINT write a final evidence JSON, stop the runtime, destroy bots and disconnect TeamSpeak (compose `stop_grace_period: 30s`).

## Monitoring (privacy-safe)

`lab/evidence/private-beta-status.json` is overwritten every 5 s. It has mode, commit, health, receiver slot id, generation, DAVE ready, and counters (`decryptErrors`, `daveReplacements`, `recoveries`, `framesSent`, drops). Lifecycle events are a ring of 200 (`starting`, `bridge_running`, `dave_ready`, `dave_lost`, `receiver_changed`, `generation_changed`, `reconnect_scheduled`, `stopping`).

Never capture audio, tokens, passwords, encryption material, guild/user names, or host addresses. Do not attach raw logs or `.env` to issues.

On shutdown the runner also writes `evidence/private-beta-*.json` (counters + events + resource averages). Keep A–D `mark` evidence from `lab:live` in separate files.

Log retention: Docker json-file 4 MB × 5 (~20 MB). Evidence directory is local and gitignored.

## Rollback

Keep the previous local image tag before rebuilding.

```bash
# Record the running SHA
packages/discord-bridge/scripts/private-beta.sh status   # sourceCommit=…

# After a bad build, go back to the previous local tag. No pull. No rebuild.
packages/discord-bridge/scripts/private-beta.sh rollback <previous-full-sha>
```

If the previous tag is missing the script exits 2 and does not start anything. To abandon the beta entirely: `private-beta.sh stop`, leave the disposable TS lab stopped, and do not pass `--confirm` again.

Tested without Docker: `scripts/private-beta.test.mjs` checks that rollback requires a SHA, `up` without `--confirm` does not start, the compose file has `restart: "no"` and no `ports:`, and the script never prints secret values.

## Real-world plan

**Phase 1 — supervised.** Actual authorised users. Watch `daveReady`, one receiver, `duplicateReceivers=0`, membership join/leave, then a clean `stop`. Optional: run A/B/D from `ACCEPTANCE.md` in this window; store those marks separately.

**Phase 2 — recovery.** Unset `D1_DAVE_SINGLE_ATTEMPT`. Use `--allow-recovery` only on the laboratory runner for test C (`kill-receiver`). Confirm disconnect handling, successor election, and fail-closed on DAVE loss. Still no container restart loop.

**Phase 3 — extended trial.** Only after Phase 1 and 2 pass. Record availability, reconnects, failures, audio interruptions and user-reported problems from the status counters. Still private, still unpublished, still not merged.

## Minimum checks before an unattended multi-day trial

All required:

1. Phase 1 supervised session stayed `health=ok` with DAVE ready and a clean shutdown.
2. Phase 2: bounded recovery and fail-closed on encryption loss observed live (not only simulated).
3. Acceptance C (`live-kill-receiver`) is LIVE PASS, or Phase 3 is explicitly accepted without it by the owner.
4. `restart: "no"` still in the compose file. No `unless-stopped` / `always`.
5. Status command works without stdin. Evidence directory is `0700`. `.env` is `0600`.
6. Rollback SHA for the last known-good local image is written down.
7. Production TeamSpeak is not in `D1_TS_HOST`.

Until 1–2 are true, do not leave it running unattended.

## GO / NO-GO for the first supervised deployment

| Decision | Verdict |
|---|---|
| First **supervised** private-beta session (Phase 1, operator present, disposable TS lab, private Discord channel) | **GO** |
| Unattended multi-day trial | **NO-GO** |
| Public distribution / public Discord / production TeamSpeak | **NO-GO** |
| Merge #504 / publish GHCR or Docker Hub bridge image / start D2–D6 | **NO-GO** |
| Change stable manager images or releases | **NO-GO** |

GO for Phase 1 rests on the one-person live smoke (DAVE ready 511 s, bidirectional audio, 0 replacements / decrypt errors / recoveries, no duplicate receivers) plus this isolated runtime. It is not D1 acceptance and not a ship decision.
