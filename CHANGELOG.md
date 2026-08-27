# Changelog

All notable changes to this opinionated fork of [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager) are documented here. See [CREDITS.md](CREDITS.md) for upstream and fork attribution.

## [Unreleased]

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
