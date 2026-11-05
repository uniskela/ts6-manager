# Commands & Radio — full registry release matrix (2026-11-05)

**Branch:** `integration/discord-bridge-commands-radio`  
**Tip (post-main merge):** includes `origin/main` / release **v1.11.4** (merge commit on branch).  
**Scope:** every slash command in `getSupportedSlashCommands()` — not only Stage F `/play` `/queue` `/stop`.

## Registry (authoritative)

| Discord | Handler | TS6 role | Media gate | Ack |
|---------|---------|----------|------------|-----|
| `/ts help` | `ts.help` | viewer | — | immediate |
| `/ts status` | `ts.status` | **admin** | — | immediate |
| `/ts online` | `ts.online` | viewer | — | immediate |
| `/ts channels` | `ts.channels` | viewer | — | immediate |
| `/ts bridge` | `ts.bridge` | **admin** | — | immediate |
| `/play` | `play` | viewer+media | yes | deferred |
| `/queue` | `queue` | viewer+media | yes | immediate |
| `/nowplaying` | `nowplaying` | viewer+media | yes | immediate |
| `/pause` | `pause` | viewer+media | yes | immediate |
| `/resume` | `resume` | viewer+media | yes | immediate |
| `/skip` | `skip` | viewer+media | yes | immediate |
| `/stop` | `stop` | viewer+media | yes | immediate |
| `/volume` | `volume` | viewer+media | yes | immediate |
| `/playlist list\|play\|create\|add\|remove` | `playlist` | viewer+media; edits **admin** | yes | deferred for play/create/add/remove |
| `/radio list\|play` | `radio` | viewer+media | yes | deferred for play |

## Matrix

| Command | Implemented | Automated | Live Stage F | Production-ready? | Notes |
|---------|-------------|-----------|--------------|-------------------|-------|
| `/ts help` | yes | PASS | not run | yes (offline) | Static help text |
| `/ts status` | yes | PASS | not run | **conditional** | Needs bound guild + WebQuery pool |
| `/ts online` | yes | PASS | not run | **conditional** | Same as status |
| `/ts channels` | yes | PASS | not run | **conditional** | Same as status |
| `/ts bridge` | yes | PASS | not run | **conditional** | Honest unavailable without URL+secret or lab status file |
| `/play` | yes | PASS | **PASS** (audible) | yes for INT-TEST path | Requires yt-dlp + connected MusicBot |
| `/queue` | yes | PASS | **PASS** | yes | |
| `/nowplaying` | yes | PASS | not run | yes (offline) | |
| `/pause` | yes | PASS | not run | yes (offline) | |
| `/resume` | yes | PASS | not run | yes (offline) | |
| `/skip` | yes | PASS | not run | yes (offline) | |
| `/stop` | yes | PASS | **PASS** | yes | |
| `/volume` | yes | PASS | not run | yes (offline) | Guild registered; cosmetic option `required` drift vs Discord |
| `/playlist *` | yes | PASS | not run | **conditional** | Prisma playlists; create/add/remove admin |
| `/radio *` | yes | PASS | not run | **conditional** | Needs radio stations in DB |

**None** of the registry commands return `not_implemented` when the backend music service and ports are installed. Automated tests do **not** use production or D1 credentials.

## INT-TEST guild registration (2026-11-05)

Target: INT-TEST application + private guild only (suffixes `…0564` / `…6084`). **No global registration. No production app.**

| Result | Detail |
|--------|--------|
| Dry-run before apply | `create=ts,nowplaying,pause,resume,skip,volume,playlist,radio`; `unchanged=play,queue,stop`; updates/collisions none |
| Applied creates | `ts`, `nowplaying`, `pause`, `resume`, `skip`, `volume`, `playlist`, `radio` |
| Preserved | `/play`, `/queue`, `/stop` unchanged |
| Left unapplied | Plan reports `update=volume` because Discord omits `required: false` on optional options — cosmetic; **no overwrite** |
| Post-apply | `create=(none)`; all 11 top-level names present on guild |

Verify:

```bash
cd packages/backend
pnpm exec tsx src/discord-command/slash-register-cli.ts \
  --application-id "$DISCORD_TEST_APPLICATION_ID" \
  --guild-id "$DISCORD_TEST_GUILD_ID" \
  --fetch-remote
```

## Post-main automated results

| Suite | Result |
|-------|--------|
| D1 (`packages/discord-bridge`) | **447/447 PASS** |
| Commands + isolation + icons | **239/239 PASS** |
| Backend `tsc --noEmit` | PASS |

Main merge: clean (no unresolved conflicts). Included upstream: release **1.11.4**, SVG icons fix, yt-dlp bump, Dependabot/CI hygiene. No schema conflicts for Commands/D1 paths observed.

## Blockers (explicit — not silent exclusions)

1. **`/ts bridge` without bridge worker** — returns unavailable until `DISCORD_BRIDGE_URL`+`DISCORD_BRIDGE_SECRET` (or lab status file). Do not fabricate status; do not start D1 pilot without approval.
2. **Combined live session** — Stage F covered play/queue/stop. Remaining commands need one supervised INT-TEST session (companion live plan).
3. **D1 live acceptance A–D** — offline 447/447 does not close hear-tests.
4. **Merge to main** — forbidden until live gaps close and a non-draft production PR is explicitly approved.
