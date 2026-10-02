# 1.10.0: Bot console, bots vs media split, and media refactors

**Date:** 2026-10-02  
**Status:** Draft, awaiting review  
**Tracks:** #164 (1.10.0 planning), #196 (per-bot media console)  
**Mockup:** private design canvas shared in the planning session (desktop, phone, before/after boards)

## Goal

Give every media bot one console where you choose what it plays and manage its queue, and make the console *replace* the scattered per-page bot pickers instead of adding another place to do the same thing.

After 1.10.0:

- **Bot Hub** is the only list of bots. Each bot opens its **console**.
- **Media Library** (the page that was "Media Bots") holds media only: library, playlists, radio stations, commands, requests, streaming defaults.
- **IPTV** keeps playlist sources and Local hosts.

## Why

Today, changing what one bot plays means picking that bot again on each page: the music play dialog and Queue tab, the Video tab, the Radio tab, and the IPTV page (per playlist). The Bot Hub and Media Bots → Bots both list every bot with different now-playing controls. A console page alone would add a third bot list, so this release removes the duplicates as it adds the console.

## Scope decisions (agreed)

| Decision | Choice |
|---|---|
| Console shape | Option B: Bot Hub is the bot list; Media Bots becomes Media Library |
| Media Library URL | Stays `/media-bots`; only the label and page title change |
| Video file tab | Dropped. Link tab also accepts a filename already in the music folder (today's Video tab behaviour) |
| Queue reorder | Drag and drop with `@dnd-kit/sortable` (mouse, touch, keyboard) |
| Long lists | Search box plus "Show more", not page numbers |
| IPTV navigation | Group browser across playlists, playlist filter, favourites + recent, country/language filters (pulls part of the "IPTV library expansion" #164 had deferred into 1.10.0) |
| Radio navigation | Mood chips from the existing `genre` field, plus an Edit station action |
| Refactors in 1.10.0 | R1 shared URL pipeline, R2 split `MusicBots.tsx`, R3 split chat handler (R3 may slip to 1.10.x) |
| NVENC | #238 stays a separate contributor PR, reviewed on its own |

## 1. Structure and navigation

**Sidebar, Automation group:** Bot Hub · Bot Flows · Media Library · IPTV.

**Bot Hub (`/bot-hub`)**

- The one list of bots. Takes over from Media Bots → Bots: **New bot**, edit, delete, start/stop, widget link.
- Each card uses the shared now-playing component (compact variant) and has **Open console**.
- The four section tiles become one row of links.

**Bot console (`/bot-hub/:botId`)**

- Header: bot name, server, channel, connection state, settings menu (edit, start/stop, widget link, delete).
- Left: Now playing + Up next.
- Right: Play something, with tabs Music · Link · Radio · IPTV.

**Media Library (`/media-bots`)**

- Tabs: Library · Playlists · Radio stations · Commands · Requests · Streaming defaults (8 tabs become 6).
- Removed: Bots, Queue, and the Video tab's stream controls. Their jobs move to the Bot Hub and the console.

**IPTV page**

- Keeps playlist sources and Local hosts.
- A channel's Stream action becomes "Stream on…": pick a bot, land on that bot's console with the channel ready to start.

**Redirects (old links keep working)**

| Old | New |
|---|---|
| `/media-bots?tab=bots` | `/bot-hub` |
| `/media-bots?tab=queue&bot=N` | `/bot-hub/N` |
| `/media-bots?tab=queue` (no bot) | `/bot-hub` |
| `/media-bots?tab=video&bot=N` | `/bot-hub/N` |
| `/media-bots?tab=video` (no bot) | `/media-bots?tab=streaming` |
| `/music-bots` | `/media-bots` (unchanged) |

**Unchanged:** Bot Flows, chat commands, every backend media start/stop endpoint, and the single media session rule.

## 2. The console page

### Components (`packages/frontend/src/pages/bot-hub/`)

| Unit | Job |
|---|---|
| `BotConsole.tsx` | Route page: loads the bot, handles not found and offline, lays out the panels |
| `NowPlayingPanel` | Shared now-playing component (full variant). Same component the hub cards use in compact form |
| `UpNextQueue` | Queue list: drag to reorder, play now, remove, shuffle, repeat (off / track / queue), clear |
| `SourcePicker` | Tab shell; one file per tab: `MusicSource`, `LinkSource`, `RadioSource`, `IptvSource` |
| `VideoOptions` | Quality, encoder, no-viewer timeout, source type. Used by Link (stream as video) and IPTV |

### Tabs

- **Music:** sub-views Songs · Playlists · Recent requests. Search box, "Show more". Songs: Play / Queue. Playlists: Play (replaces the queue) / Queue (appends). Recent requests: the latest `!play` history (the API returns the newest 100).
- **Link:** YouTube, Twitch, direct URL, or a filename already in the music folder. A clear choice: **Play as music** (`play-url`) or **Stream as video** (`stream/start`). Video options show only for "Stream as video".
- **Radio:** search plus mood chips (All, then each distinct `genre` with a count), Play. Adding and editing stations stays in Media Library → Radio stations, which gains **Edit station**.
- **IPTV:** see "IPTV navigation" below. Video options shown.

### IPTV navigation

Playlists often hold hundreds or thousands of channels, so the IPTV tab is a browser, not a flat list.

- **Views:** Favourites · Recent · Browse groups. Opens on Favourites when there are any, else Browse groups.
- **Browse groups:** every distinct `group-title` across this server's playlists, with channel counts, filterable; "Show all groups" past the first 30. Opening a group lists its channels (logo, name, playlist) with "Show more", and "← All groups" to go back.
- **Search:** searches all channels, or only the open group.
- **Filters:** Playlist (All, or one), Country and Language. Country and Language only appear once at least one channel on the server has those values.
- **Each channel row:** Stream, and a star to add or remove it from favourites.

**Stable channel keys.** A playlist refresh deletes and recreates every channel (`iptv-service.ts`), so channel IDs change. Favourites and recents store `playlistId` plus a key: `tvg-id` when present, else the channel name. They match the current channel on read. A favourite whose channel has gone from the playlist shows as "No longer in this playlist" with a Remove action.

**Favourites and recent are per server**, shared by every admin of that server, the same as playlists and radio stations. Recent keeps the last 20 channels streamed on that server, recorded when a stream starts from the console, the IPTV page or `!tv`.

**Country and language** come from the M3U `tvg-country` and `tvg-language` attributes, which the parser reads but does not store today. Values can list several codes (`US;CA`); filters split on `;` and `,`. Existing playlists gain these values on their next refresh (manual or automatic).

### Data

Existing queries only; no new polling.

- `useBotMedia` (`GET /api/music-bots/media`): session, video quality and encoder, health, viewers, auto-stop, last stop reason.
- `useMusicBotState(botId)`: track, progress, queue, shuffle, repeat.
- Both already refresh every 1–3 s, so the panel tracks starts, stops, replacements and auto-stops without a reload.

### Starting and stopping

Existing endpoints only: `play`, `queue`, `queue/playlist`, `play-url`, `play-radio`, `stream/start`, `iptv/stream`, the stop routes, `queue/move` for drag and drop. A conflict goes through the existing global `MediaSwitchDialog` ("Replace what is playing?"). The console adds no switching logic.

When a video replaces music, the backend keeps the queue (`clearPlayback` does not touch it). Up next stays visible and is marked paused until music starts again.

### Video options

Start from the server's streaming defaults. Changes apply to that one start only and never save over the defaults.

### Edge cases

| Case | Behaviour |
|---|---|
| Unknown bot ID | "Bot not found" with a link back to the Bot Hub |
| Bot stopped or offline | Source tabs disabled with "Start the bot to play something" and a **Start bot** button |
| Start fails | Inline error above the start button, same wording as today (`apiErrorMessage`) |
| Media still starting | Existing dialog text "Media is still starting" |

### Phone width

One column: now playing, up next, then sources. The tab row scrolls sideways. Video options fold into "More options". Touch targets at least 44 px.

### Lists and paging

| List | Change |
|---|---|
| Songs | `GET /songs` gains optional `search`, `page`, `pageSize` (returns `{ total, page, pageSize, songs }` only when `page` is given). Without them it returns the full list as today, so the Library tab is unaffected |
| Playlists | Filtered in the browser; "Show more" after 25 |
| Recent requests | Existing endpoint (newest 100); "Show more" in the browser |
| Radio stations | Filtered in the browser by search and mood |
| IPTV groups | New groups endpoint with counts; "Show all groups" past 30 |
| IPTV channels | New cross-playlist search, paged like the per-playlist endpoint |
| Up next | Whole queue shown; scrolls inside the panel |

### Backend changes (complete list)

All new routes are admin only and scoped to one server, like the existing IPTV and radio routes.

1. `GET /songs`: optional `search`, `page`, `pageSize` (backward compatible).
2. `GET /api/iptv/groups?serverConfigId=&playlistId=&country=&language=`: distinct groups with channel counts.
3. `GET /api/iptv/channels?serverConfigId=&playlistId=&group=&country=&language=&search=&page=&pageSize=`: cross-playlist channel search.
4. `GET/PUT/DELETE /api/iptv/favourites`: list, add, remove favourites by stable key.
5. `GET /api/iptv/recent`: the last 20 streamed channels; recorded inside the existing IPTV stream start paths (route and `!tv`).
6. `PUT /radio-stations/:id`: edit name, URL and genre, with the same `validateUrl` check as adding a station.

### Data model changes (SQLite, Prisma migrations)

- `IptvChannel`: add nullable `tvgCountry` and `tvgLanguage`; the M3U parser stores them.
- New `IptvChannelPick`: `serverConfigId`, `playlistId`, `channelKey`, `name` (for display when the channel has gone), `favourite` (boolean), `lastStreamedAt` (nullable). Unique on `serverConfigId` + `playlistId` + `channelKey`. Cascades when its server or playlist is deleted. One table holds both favourites and recents.

## 3. Refactors

### R1: Shared URL pipeline (backend)

- New `packages/backend/src/voice/media-url-pipeline.ts`: resolve a link (Spotify, Apple Music, YouTube or YouTube Music playlist, direct URL) to tracks with the existing 25-track cap; download and start the first track; queue the rest in the background, resuming playback if the first track ends before the next is ready.
- Callers become thin wrappers: the `POST /:id/play-url` route and chat `!play` (`enqueueMediaUrl` in `music-command-handler.ts`).
- **Tests first:** characterization tests pin each caller's current behaviour, including error messages and enqueue-only mode, and must pass unchanged after the move.

### R2: Split `MusicBots.tsx`

- Becomes `packages/frontend/src/pages/media-bots/` with one file per tab plus shared dialogs (`PlaySongDialog`, import options).
- A pure move: no visible or behaviour change. Typecheck and existing tests are the safety net.

### R3: Split `music-command-handler.ts`

- Becomes `packages/backend/src/voice/commands/`: routing (parse, cooldowns, dedupe, dispatch), channel ownership (helper park/rebalance, channel mapping, session ownership), and handlers grouped as playback, queue, streaming/TV, info.
- `MusicCommandHandler` keeps its public methods; nothing outside the folder changes.
- Existing chat command tests must pass unchanged. May slip to 1.10.x without blocking the release.

### Not in 1.10.0

`voice-bot.ts` and sidecar `main.go` splits; framework upgrades; EPG/XMLTV/Xtream; a video library (upload, list, delete); per-user (rather than per-server) favourites; multiple mood tags per radio station; dynamic quality changes during a stream; the flow loop node.

## 4. PR order

| # | PR | Can start | Release effect |
|---|----|-----------|----------------|
| 0 | Merge release PR #252 (1.9.4) first, if shipping it separately | now | patch |
| 1 | `refactor:` split MusicBots.tsx (R2) | now | none |
| 2 | `refactor:` shared URL pipeline (R1) | now | none |
| 3 | `refactor:` shared NowPlaying component (hub card + Media Bots card) | after 1 | none |
| 4 | `feat:` console page, Now playing, Up next with drag and drop, hub "Open console" | after 3 | minor → 1.10.0 |
| 5 | `feat:` console Music tab (Songs · Playlists · Recent) + Radio tab with mood chips, `/songs` search and paging | after 4 | — |
| 5b | `feat:` edit radio stations (`PUT` route + Edit in Media Library → Radio stations) | now | — |
| 6 | `feat:` console Link tab (music or video, music-folder filename) + video options | after 4 | — |
| 7 | `feat:` console IPTV tab: group browser, cross-playlist search, playlist filter | after 4 | — |
| 7b | `feat:` IPTV country and language (migration, parser, filters) | after 7 | — |
| 7c | `feat:` IPTV favourites and recent (migration, routes, views) | after 7 | — |
| 8 | `feat:` Bot Hub becomes the bot list; Media Library 6 tabs; IPTV "Stream on…"; redirects | after 5–7c | — |
| 9 | `docs:` / `test:` docs, Playwright, 1.10.0 smoke checklist | after 8 | none |
| 10 | `refactor:` split chat handler (R3) | now, in parallel | none |

PR 8 uses `feat:`, not `feat!:`: old URLs redirect and no API changes, so a `!` (which would bump to 2.0.0) is wrong.

## 5. Testing

**Unit (frontend):** source-to-request mapping for each tab (Music views, Link as music vs video, filename vs URL, Radio, IPTV, video options); the redirect table.

**Unit (backend):** R1 characterization tests (web and chat); `/songs` paging stays backward compatible; IPTV groups and cross-playlist search (counts, filters, paging, admin only, scoped to one server); M3U parser stores `tvg-country` and `tvg-language`; favourites and recents survive a playlist refresh via stable keys, show "No longer in this playlist" when a channel disappears, and recent is capped at 20; radio station edit validates the URL like add does; R3 keeps existing chat command tests green.

**Playwright (docs mode):** new `bot-console.spec.ts` covering open from hub, start each media type, the replace prompt then replace, stop, drag-and-drop reorder (mouse and keyboard), remove, and phone width. Update `bot-hub.spec.ts`, `sidebar.spec.ts`, `docs-screenshots.spec.ts`; re-check `iptv-local-hosts.spec.ts`.

**Before every push:** `pnpm typecheck`, backend and frontend unit tests, the Playwright suite, and `go test` when a PR touches the sidecar. Node 20 and pnpm 9 per AGENTS.md.

## 6. Docs

- `docs/music-bots.md`: Bot Hub and console, Media Library tabs.
- `docs/video-streaming.md` and the IPTV section: starting from the console; filename sources via the Link tab.
- `docs/roadmap.md`: 1.10.0 entry.
- New `docs/plans/164-1-10-0-rc-smoke.md`, run in the homelab before the release PR merges (VAAPI on the AMD GPU; NVENC if #238 lands).

## Acceptance

- [ ] From one bot's console you can start music, a link (as music or video), radio and IPTV. A second start prompts first, then replaces the current session.
- [ ] Now playing and Up next match the bot's real state after a start, stop, replacement or auto-stop, without a reload.
- [ ] Up next reorders by drag and drop with mouse, touch and keyboard.
- [ ] IPTV: browse by group across playlists, filter by playlist, country and language, star favourites, and see recent channels. Favourites survive a playlist refresh.
- [ ] Radio: filter stations by mood; edit an existing station's mood.
- [ ] Bot Hub is the only bot list; Media Library has 6 tabs; every old link in the redirect table lands correctly.
- [ ] The console is usable at phone width.
- [ ] R1 and R2 land with no behaviour change (characterization tests and existing tests green).
- [ ] Docs and the 1.10.0 smoke checklist cover the console.
