# Supervised live plan — full Commands & Radio registry (INT-TEST)

One sitting. INT-TEST Discord app + disposable TeamSpeak only. No production. No global slash registration. Clear Interactions URL before tunnel teardown.

## Preconditions

- [ ] Guild slash commands dry-run reviewed; apply **guild-only** on INT-TEST if missing names
- [ ] Guild bound to MusicBot; viewer/admin role IDs or isolated-live Administrator latch
- [ ] Disposable TS with MusicBot nickname visible
- [ ] `yt-dlp` absolute path; no sentinel cookie jar
- [ ] Optional for `/ts bridge`: `DISCORD_BRIDGE_STATUS_FILE` pointing at private-beta status JSON, or bridge URL+secret

## Single session checklist

| # | Command | Expect | Record |
|---|---------|--------|--------|
| 1 | `/ts help` | Help list | live-ok / fail |
| 2 | `/ts online` | Nicknames (or empty) | |
| 3 | `/ts channels` | Channel names | |
| 4 | `/ts status` (admin) | Connected line | |
| 5 | `/ts status` (viewer) | Permission denial | deny-ok |
| 6 | `/ts bridge` (admin) | daveReady/slot/generation **or** unavailable if bridge off | |
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
| 19 | `/radio list` | Stations or empty | |
| 20 | `/radio play` | If stations exist | |

Cleanup: clear INT-TEST Interactions URL → stop tunnel/filter → interactions disabled.

## Do not

- Claim PASS without operator confirmation for audible steps
- Register on production Uniskela app
- Leave trycloudflare URL configured after the session
