# Supervised live plan — full Commands & Radio registry (INT-TEST)

One sitting. INT-TEST Discord app + disposable TeamSpeak only. No production. No global slash registration. Clear Interactions URL before tunnel teardown.

## Preconditions

- [x] Guild slash commands dry-run reviewed; **guild-only** creates applied on INT-TEST (2026-11-05)
- [x] `/play` `/queue` `/stop` preserved; volume cosmetic drift left unapplied
- [x] CI findings triage/fixes pushed on integration (hygiene, Sonar highs, CodeQL) — re-check PR #601 before live
- [ ] Guild bound to MusicBot; viewer/admin role IDs or isolated-live Administrator latch
- [ ] Disposable TS with MusicBot nickname visible
- [ ] `yt-dlp` absolute path; no sentinel cookie jar
- [ ] Optional for `/ts bridge`: `DISCORD_BRIDGE_STATUS_FILE` (lab JSON) — **do not** fabricate D1 status; skip bridge hear if no isolated source
- [ ] Interactions URL via path filter + short-lived tunnel only for this session (**do not start tunnel until operator is available**)

## Disposable fixtures (prepare before operator joins)

1. Ensure isolated DB has at least one MusicBot bound to the INT-TEST guild.
2. Create throwaway playlist via admin `/playlist create name:live-smoke` then `/playlist add` with a short HTTPS sample (e.g. SoundHelix).
3. If radio stations empty, insert one disposable station in the isolated DB (HTTPS stream) **or** skip `/radio play` and record skip.
4. Pre-stage `/play` URL (HTTPS) known to work with local yt-dlp.

## Single session checklist

| # | Command | Expect | Record |
|---|---------|--------|--------|
| 1 | `/ts help` | Help list | live-ok / fail |
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
| 19 | `/radio list` | Stations or empty | |
| 20 | `/radio play` | If stations exist | |
| 21 | Viewer tries `/playlist create` | Permission denial | deny-ok |

Cleanup: clear INT-TEST Interactions URL → stop tunnel/filter → interactions disabled → remove throwaway playlist/station if desired.

## Do not

- Claim PASS without operator confirmation for audible steps
- Register on production Uniskela app
- Leave trycloudflare URL configured after the session
- Start D1 pilot or invent bridge health JSON
