# Commands & Radio — full registry release matrix (2026-11-05)

**Branch:** `integration/discord-bridge-commands-radio`  
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
| `/ts status` | yes | PASS | not run | **conditional** | Needs bound guild + WebQuery pool (now wired) |
| `/ts online` | yes | PASS | not run | **conditional** | Same as status |
| `/ts channels` | yes | PASS | not run | **conditional** | Same as status |
| `/ts bridge` | yes | PASS | not run | **conditional** | Needs `DISCORD_BRIDGE_URL`+secret **or** lab `DISCORD_BRIDGE_STATUS_FILE`; else honest unavailable |
| `/play` | yes | PASS | **PASS** (audible) | yes for INT-TEST path | Requires yt-dlp + connected MusicBot |
| `/queue` | yes | PASS | **PASS** | yes | |
| `/nowplaying` | yes | PASS | not run | yes (offline) | |
| `/pause` | yes | PASS | not run | yes (offline) | |
| `/resume` | yes | PASS | not run | yes (offline) | |
| `/skip` | yes | PASS | not run | yes (offline) | |
| `/stop` | yes | PASS | **PASS** | yes | |
| `/volume` | yes | PASS | not run | yes (offline) | |
| `/playlist *` | yes | PASS | not run | **conditional** | Needs Prisma playlists; create/add/remove admin |
| `/radio *` | yes | PASS | not run | **conditional** | Needs radio stations in DB |

**None** of the registry commands return `not_implemented` when the backend music service and ports are installed.

## Blockers (explicit — not silent exclusions)

1. **`/ts bridge` without bridge worker** — returns unavailable until `DISCORD_BRIDGE_URL`+`DISCORD_BRIDGE_SECRET` (or lab status file) is set. D1 HTTP `/health` contract is forward-compatible; private-beta still primarily status-file based.
2. **Combined live session** — Stage F covered only play/queue/stop. Remaining commands need one supervised INT-TEST session (see companion live plan).
3. **D1 live acceptance A–D** — unchanged; offline 447/447 does not close hear-tests.
4. **origin/main drift** — integration branch is behind `v1.11.4` / recent main commits; rebase before production PR.

## Guild registration (INT-TEST only)

Dry-run (no apply):

```bash
cd packages/backend
pnpm exec tsx src/discord-command/slash-register-cli.ts \
  --application-id "$DISCORD_TEST_APPLICATION_ID" \
  --guild-id "$DISCORD_TEST_GUILD_ID" \
  --fetch-remote
```

Apply remains an explicit operator step (`slash-registration` apply path). Never register globally; never touch production app.
