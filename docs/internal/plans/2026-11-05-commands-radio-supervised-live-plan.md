# Supervised live plan — full Commands & Radio registry (INT-TEST)

One sitting. INT-TEST Discord app + disposable TeamSpeak only. No production. No global slash registration. Clear Interactions URL before tunnel teardown.

## Preconditions

- [x] Guild slash commands dry-run reviewed; **guild-only** creates applied on INT-TEST (2026-11-05)
- [x] `/play` `/queue` `/stop` preserved; volume cosmetic drift left unapplied
- [x] CI findings triage/fixes pushed on integration (hygiene, Sonar highs, CodeQL, history race regressions)
- [x] PR #601 product checks green (keep tip CI green before tunnel)
- [x] Architecture review commits integrated; release findings included
- [x] Guild bound to MusicBot 10 / server 1; viewer + admin role IDs set; `DISCORD_INTERACTIONS_ENABLED=false` until GO
- [x] Disposable TS up (`127.0.0.1:19987` UDP + WebQuery `11080`); voice client **DiscordIntLab** visible
- [x] Isolated `yt-dlp` 2026.10.26 at `tools/discord-int/bin/yt-dlp`; `YT_DLP_PATH` set; SoundHelix metadata probe OK; no cookie jar on INT path
- [x] Disposable radio station seeded (`INT disposable SoundHelix`); playlist `remoteAccess` column present on isolated DB
- [x] INT backend running from **#601 integration worktree** on `127.0.0.1:3011` (`TS6_ISOLATED_INTEGRATION=1`, interactions off)
- [ ] Optional for `/ts bridge`: `DISCORD_BRIDGE_STATUS_FILE` (lab JSON) — **do not** fabricate D1 status; expect honest unavailable if unset
- [ ] Interactions URL via path filter + short-lived tunnel only for this session (**do not start until operator GO**)

## Disposable fixtures

1. Guild ↔ MusicBot 10 bound (`instanceId=discord-int-test`).
2. Create throwaway playlist live via admin `/playlist create name:live-smoke` then `/playlist add` with SoundHelix HTTPS.
3. Radio: station id 1 already present — exercise `/radio list` + `/radio play`.
4. Pre-staged `/play` URL: `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3`

## Operator steps (start only after explicit GO)

Do **not** point production Discord apps or production Interactions URLs here. Guild-only. No global registration.

### 1. Start the temporary test endpoint

```bash
cd /path/to/integration-discord-bridge-commands-radio/packages/backend
set -a; . ../../.env.discord-integration-test; set +a
# Confirm still prep-safe:
#   DISCORD_INTERACTIONS_ENABLED=false  LISTEN_HOST=127.0.0.1  TS6_ISOLATED_INTEGRATION=1
# Backend should already be on :3011 from prep; if not:
#   pnpm exec tsx src/index.ts

# Path-filter + short-lived public HTTPS to ONLY /api/discord/interactions
# Example (trycloudflare / cloudflared) — pick one operator-approved tunnel:
cloudflared tunnel --url http://127.0.0.1:3011
# Prefer a filter that rejects non-interactions paths if available.

# In Discord Developer Portal → INT-TEST application only:
#   Interactions Endpoint URL = https://<tunnel>/api/discord/interactions
# Wait for Discord validation (200) before enabling the flag.

# Enable interactions for the supervised window only, then restart backend:
#   DISCORD_INTERACTIONS_ENABLED=true
# Optional latch if required by this build:
#   TS6_ISOLATED_LIVE_INTERACTIONS=1
```

Guild slash inventory: dry-run first; apply **guild-only** updates only if create/update list is intentional (volume cosmetic drift may stay unapplied).

```bash
node --import tsx src/discord-command/slash-register-cli.ts \
  --application-id "$DISCORD_TEST_APPLICATION_ID" \
  --guild-id "$DISCORD_TEST_GUILD_ID" \
  --fetch-remote
# Apply only with explicit confirms from the CLI contract — never global.
```

### 2. Connect Discord and TeamSpeak clients

- Discord: INT-TEST guild only. Have one **admin** account and one **viewer** account (or role swap).
- TeamSpeak: disposable INT server voice (loopback / private publish — not production). Confirm nickname **DiscordIntLab** is present before `/play`.

### 3–4. Run the 21-command checklist and record results

Use the table below. Mark `live-ok` / `fail` / `deny-ok` / `skip`. Audible rows need a human ear on TeamSpeak.

| # | Command | Expect | Record |
|---|---------|--------|--------|
| 1 | `/ts help` | Help list | |
| 2 | `/ts online` | Nicknames (or empty) | |
| 3 | `/ts channels` | Channel names | |
| 4 | `/ts status` (admin) | Connected line | |
| 5 | `/ts status` (viewer) | Permission denial | deny-ok |
| 6 | `/ts bridge` (admin) | daveReady/slot/generation **or** honest unavailable | |
| 7 | `/queue` | Empty or list | |
| 8 | `/nowplaying` | Idle or title | |
| 9 | `/play` SoundHelix HTTPS | Audible in TS | **need operator hear** |
| 10 | `/volume 50` | Confirm | |
| 11 | `/pause` / `/resume` | Audible change | **need operator hear** |
| 12 | `/skip` | Next or stop | |
| 13 | `/stop` | Silence | **need operator hear** |
| 14 | `/playlist list` | List or empty | |
| 15 | `/playlist create` (admin) | Created | |
| 16 | `/playlist add` (admin) | Added HTTPS URL | |
| 17 | `/playlist play` | Queues | |
| 18 | `/playlist remove` (admin) | Removed | |
| 19 | `/radio list` | Stations | |
| 20 | `/radio play` | Plays disposable station | |
| 21 | Viewer `/playlist create` | Permission denial | deny-ok |

### Session result (2026-11-05, tip `39419d32`)

**Corrected tally: 17 PASS, 2 FAIL, 2 NOT TESTED.** External endpoint cleaned up successfully.

| # | Result | Note |
|---|--------|------|
| 18 | FAIL | Add showed `Media from www.soundhelix.com`; remove matched stored title only after enrichment |
| 20 | FAIL | Isolated media fetcher absent; Discord reply was generic “Radio playback failed.” |
| 5, 21 | NOT TESTED | No genuine viewer-only Discord identity exercised |

Focused fix branch (do not merge #601 yet): playlist remove aliases + `/playlist tracks`, MediaEgressError pass-through, INT-only fetcher compose, viewer prep notes. Retest only #5, #18, #20, #21 after a new operator GO — do not restart the full matrix.

### Targeted live retest (after GO)

1. Re-register guild commands so `/playlist tracks` is present.
2. Optional: start `docker-compose.discord-int-media-fetcher.yml` and set `MEDIA_FETCHER*` in the INT env; otherwise expect actionable unavailable text on #20.
3. Confirm a viewer-only member (VIEWER role, no ADMIN roles) before #5/#21.
4. #18: `/playlist add` → `/playlist tracks` → remove by `#N` or displayed host title after enrichment.
5. Tear down tunnel + fetcher; leave interactions off.

### 5. Remove Interactions URL and stop the tunnel

1. Discord Developer Portal (INT-TEST app only): clear Interactions Endpoint URL → Save.
2. Stop cloudflared / tunnel process.
3. Set `DISCORD_INTERACTIONS_ENABLED=false` (and clear live latch if set); restart backend.
4. Confirm `curl -sS http://127.0.0.1:3011/api/health` still ok and interactions remain off in env.

### 6. Verify isolated environment is clean

- [ ] Interactions URL empty on INT-TEST app (not production).
- [ ] Tunnel process gone; no public hostname left configured.
- [ ] `DISCORD_INTERACTIONS_ENABLED=false`; backend still `LISTEN_HOST=127.0.0.1`.
- [ ] No global slash registration performed.
- [ ] Optional: remove throwaway `live-smoke` playlist; keep or drop disposable radio station.
- [ ] Do not grant Tailscale access to the development VPS for volunteers.

## Do not

- Claim PASS without operator confirmation for audible steps
- Register on production Uniskela app / change production Interactions URL
- Leave trycloudflare URL configured after the session
- Start D1 pilot, invent bridge health JSON, or expose the development VPS to community volunteers
