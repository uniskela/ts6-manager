# Changelog

All notable changes to this opinionated fork of [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager) are documented here. See [CREDITS.md](CREDITS.md) for upstream and fork attribution.

## [Unreleased]

### Added

- Deployment self-check in connection setup wizard step 1: probes localhost, `teamspeak`, and `host.docker.internal` from the manager backend and suggests a scenario/host (`GET /api/servers/deployment-check`)

### Changed

- Connections tab is minimal when empty — wizard opens directly from dashboard links; detailed help moved to an optional dialog
- Connection setup guide card hidden until at least one connection exists
- `docker-compose.pr-test.yml` includes a TeamSpeak 6 server (`teamspeak` hostname on the compose network) for end-to-end wizard testing

## [1.3.8] - 2026-09-01

### Added

- Connection setup guide on Settings → Connections with checklist, deployment scenarios (Docker/remote/same-host), and feature matrix (WebQuery vs SSH)
- Optional multi-step connection setup wizard with WebQuery/SSH draft testing before save
- Field-level tooltips and sectioned connection form (WebQuery required, SSH optional)
- SSH test endpoints (`POST /api/servers/test-ssh`, `POST /api/servers/:id/test-ssh`) and Test SSH buttons on connection cards
- Dashboard nudge banner for admins with no server connections (links to `/settings?tab=connections`)

### Security

- SSRF hardening for TeamSpeak connection hosts: validate/sanitize host and port before WebQuery/SSH outbound requests; block cloud-metadata targets and URL tricks; optional DNS resolution check on draft connection tests (`TS_ALLOW_PRIVATE_HOSTS=false` to disallow private/loopback hosts)
- CodeQL request-forgery barriers for validated TeamSpeak endpoint helpers (`.github/codeql/extensions/ts6-connection-host/`)

### Fixed

- Connection edit form no longer requires re-entering the API key when unchanged

## [1.3.7] - 2026-09-01

### Added

- Auth refresh single-flight with Web Lock serialization (adapted from [coom/ts6-manager@9658cfb](https://github.com/coom/ts6-manager/commit/9658cfbbe5f33867efd96b5c883a5ce8f3dc0639))
- `/auth/me` re-fetch on layout mount to fix stale admin role in sidebar
- YouTube playlist import service with background jobs, `youtubePlaylistId` / `serverConfigId` on playlists, and minimal English UI (adapted from coom Aug 2026 import series)
- Video download-then-stream via proxied yt-dlp (`bv*+ba/b`, temp files under `MUSIC_DIR`)
- Auto-stop music/video when bot channel is empty (`BOT_AUTO_STOP_EMPTY_SECONDS`, default 300)
- Video stream volume slider and max video duration setting (Settings → YouTube → Limits)
- SSH host-key fingerprint pinning on first ServerQuery SSH connect
- WebSocket broadcasts scoped by user enabled state and allowed `serverConfigId`s
- `docs/bot-flows.md` — bot flow reference (adapted from uniplayer1)

### Security

- Admin-only GET on bot flow routes (webhook secrets)
- Admin-only reads for privilege keys, widget tokens, client DB, banlist, logview
- yt-dlp URL guard: reject `-` prefixes; literal `--` before positional media URLs

### Fixed

- WebQuery boolean coercion in Clients/Messages (`Number(x) === 1` for away/read flags)
- TS3 error 2568 (insufficient permissions) no longer treated as fatal disconnect

### Changed

- Extended [CREDITS.md](CREDITS.md) with fork contributions table (coom, uniplayer1)
- Docker startup: upgrade-aware schema apply (`apply-schema.sh`) detects older DBs / version bumps and runs `prisma db push` on compose up

## [1.3.6] - 2026-08-28

### Added

- **Phase B:** Import Apple Music / YouTube playlists directly to a **running music bot queue** (`musicBotId`, optional `clearFirst`) without creating a playlist
- TS6 **Markdown** formatting for `!help`, `!np`, `!queue`, and `!radio` bot replies (headings, lists, `<details>` controls hint)
- Custom command editor documents TS6 Markdown / BBCode formatting for responses
- **TS6-style formatting toolbar** on custom command responses (bold, lists, spoilers, headings, code, math, tables, Mermaid, BBCode snippets)

### Fixed

- **Import as Playlist** no longer sends `musicBotId` when a bot is selected but queue import was not requested
- **Import to queue** available after **Load** on library and playlist URL flows
- `!np` “… and N more” queue count accounts for current track index

### Changed

- `!np` / `!nowplaying` shows track progress, up next, and expandable playback control hints (text commands — TS6 has no clickable skip/pause buttons in bot messages)

### Fixed

- **Load & Play** on stream playlists now starts playback after loading the queue (not only enqueue)
- yt-dlp YouTube downloads use flexible audio format selection (`bestaudio` fallbacks) instead of forcing opus extraction, with player-client rotation for bot-check / format errors

- Music bots can accept `!commands` in **additional channels** (channel ID list) and reply there while staying in the default playback channel
- Uses ServerQuery SSH text-channel listeners; configure under Music Bots → bot settings
- On `!play` (and `!radio <id>`), the voice bot **joins the command channel** so audio plays where the user typed the command

## [1.3.5] - 2026-08-28

### Changed

- Default **max playlist import** raised from 50 → **250** (still configurable up to 500 in Settings → Limits)

### Fixed

- Apple Music / playlist import jobs report `sourceTrackCount` and warn when capped (e.g. 259-track playlist with limit 50)
- Import progress shows `Matching X/Y of 259`; completion toast tells you to raise Settings cap when truncated

## [1.3.4] - 2026-08-28

### Added

- Background **Import as Playlist** / **Import all** for Apple Music URLs (matches YouTube on YouTube, registers on stream playlists without downloading)
- Import jobs show **matching** progress for Apple Music (`Matching 45/259 (42 hits)`) before adding tracks
- Paste Apple Music URL and import without **Load** (library tab and playlist editor)

### Fixed

- Apple Music **Load URL** no longer fails at 15s while the backend is still matching tracks — client timeout raised to 5 minutes and nginx `/api` proxy timeouts set to 300s
- Apple Music load UI shows match progress (`98 matched of 259 (first 100 searched)`) and clearer timeout error messages
- Duplicate YouTube video matches in Apple Music playlists no longer collapse selection checkboxes
- Stream playlist import registers YouTube tracks on-demand instead of bulk-downloading

## [1.3.3] - 2026-08-27

### Added

- Stream playlists: Add from URL **registers** YouTube tracks without downloading; audio is fetched on first play
- `POST /music-library/youtube/register` for URL-only song rows (empty `filePath` until played)

### Changed

- Apple Music / URL Load matching cap raised from 15 → **100** tracks (parallel YouTube search)

### Fixed

- Stream-only playlists no longer bulk-download when adding from a loaded URL

## [1.3.2] - 2026-08-27

### Fixed

- Apple Music **Load URL** matches YouTube tracks in parallel (avoids proxy timeouts on large playlists like 250+ tracks)
- `/youtube/info` returns the real error message as HTTP 502 instead of a generic 500
- Frontend Load toast shows the server error text
- `/api/health` reports backend `version` (+ optional `gitSha`) so deploys can confirm backend matches the UI

## [1.3.1] - 2026-08-27

### Added

- `!shuffle [on|off]` chat command to toggle or set queue shuffle

### Fixed

- Apple Music user playlist IDs (`pl.u-…` with hyphens) parse correctly
- Library / playlist **Load URL** resolves Apple Music links via metadata + YouTube match instead of sending them to yt-dlp (fixes `Unsupported URL: music.apple.com`)

## [1.3.0] - 2026-08-27

### Breaking Changes

- Music bot `!` command replies (built-in and custom) are sent to **channel chat** instead of a private DM

### Added

- Stream playlists: Add Songs → **URL** tab (YouTube video/playlist import into the selected playlist)
- Queue tab: **Add to queue** for songs and playlists (append, does not clear)
- Playlists: edit name and local/stream mode (YouTube-linked playlists stay stream)
- [AGENTS.md](AGENTS.md) release process: CHANGELOG sections, `vX.Y.Z` tags, GitHub Releases, GHCR publish on `v*`

### Changed

- Commands tab help text documents channel-chat replies
