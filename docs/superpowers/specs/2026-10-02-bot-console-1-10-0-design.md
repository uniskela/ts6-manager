# 1.10.0: Bot console, bots vs media split, and media refactors

**Date:** 2026-10-02  
**Status:** Draft, reviewed 2026-10-02, awaiting approval  
**Tracks:** #164 (1.10.0 planning), #196 (per-bot media console)  
**Mockup:** private design canvas shared in the planning session (desktop, phone, before/after boards)

## Goal

Give every media bot one console where you choose what it plays and manage its queue, and make the console *replace* the scattered per-page bot pickers instead of adding another place to do the same thing.

After 1.10.0:

- **Bot Hub** is the only list of bots. Each bot opens its **console**.
- **Media Library** (the page that was "Media Bots") holds media only: library, playlists, radio stations, requests, streaming defaults.
- **Bot Flows** holds everything that reacts to chat: flows and custom chat commands.
- Media (songs, playlists, radio stations, IPTV, favourites) is shared by every bot on the same TeamSpeak server. Nothing is per bot.
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
| Long lists | Page numbers with a Per page picker (25 / 50 / 100), remembered per list in the browser. Up next is not paged |
| Radio in Now playing | Station name and ICY title, no progress or skip; the queue is kept and can be resumed |
| Auto-stop notices | Every auto-stop posts one line in channel chat; video also warns 1 minute before a no-viewer stop. On by default, switch in Streaming defaults |
| IPTV navigation | Group browser across playlists, playlist filter, favourites + recent, country/language filters (pulls part of the "IPTV library expansion" #164 had deferred into 1.10.0) |
| Radio navigation | Mood chips from the existing `genre` field, plus an Edit station action |
| Media scope | Shared by all bots on a server, never per bot. Playlists drop their per-bot filter |
| Custom chat commands | Move to Bot Flows → Chat commands, with a read-only list of built-in commands and name clash warnings |
| Refactors in 1.10.0 | R1 shared URL pipeline, R2 split `MusicBots.tsx`, R3 split chat handler (R3 runs last and may slip to 1.10.x) |
| Cut line | Must-have for 1.10.0: console, its tabs, the restructure, shared playlists, auto-stop notices, R1, R2. May slip to 1.10.x: IPTV favourites + recent, IPTV country/language, bot avatars, R3 |
| Command permissions | Not in 1.10.0. Planned for 1.11.0 in #254, with the listener remote (#253), which depends on them |
| Bot avatars | Per-bot avatar plus a default for new bots, set in the console's bot settings. Can slip. TS6 support confirmed in #259 |
| NVENC | #238 stays a separate contributor PR. Merge it before PR 5 (both touch `VideoStreamSettings` and the Streaming defaults card); the smoke checklist covers NVENC |

## 1. Structure and navigation

**Sidebar, Automation group:** Bot Hub · Bot Flows · Media Library · IPTV.

### Shared media (not per bot)

Songs, radio stations, IPTV playlists, custom chat commands and the new IPTV favourites/recent are already stored per server. Playlists are the exception, and 1.10.0 aligns them:

- `GET /playlists` returns playlists from every server today. It gains a `serverConfigId` filter, and the console and Media Library always pass the selected server.
- A playlist can carry an optional `musicBotId`, and chat `!playlist` only lists that bot's playlists plus untied ones. 1.10.0 ignores `musicBotId` for listing and playing: every bot sees every playlist on its server. The column stays (no migration) and the UI stops offering a bot link. Visible change: `!playlist` may list more playlists than before.

**Bot Hub (`/bot-hub`)**

- The one list of bots. Takes over from Media Bots → Bots: **New bot**, edit, delete, start/stop, widget link.
- Each card uses the shared now-playing component (compact variant) and has **Open console**.
- The four section tiles become one row of links.

**Bot console (`/bot-hub/:botId`)**

- Header: bot name, server, channel, connection state, settings menu (edit, start/stop, widget link, delete).
- Left: Now playing + Up next.
- Right: Play something, with tabs Music · Link · Radio · IPTV.

**Media Library (`/media-bots`)**

- Tabs: Library · Playlists · Radio stations · Requests · Streaming defaults (8 tabs become 5).
- Removed: Bots, Queue, and the Video tab's stream controls (their jobs move to the Bot Hub and the console), and Commands (moves to Bot Flows).

**Bot Flows (`/bots`)**

- Two tabs: **Flows · Chat commands**.
- Chat commands holds the custom text replies (`!rules` → message) unchanged: add, edit, enable/disable, presets.
- It also shows a **read-only list of built-in commands** (`!play`, `!tv`, `!stream` and the rest) so the whole command set is visible in one place.
- **Name clash warnings** appear when a custom reply, a flow's command trigger or a built-in command share a name, on both the Chat commands tab and the flow editor's command trigger.
- Who answers does not change: custom replies are answered by media bots in their command channels, flows by the flow engine. The tab says so.

**IPTV page**

- Keeps playlist sources and Local hosts.
- A channel's Stream action becomes "Stream on…": pick a bot, then open `/bot-hub/N?iptv=<playlistId>:<channelKey>`. The console opens on the IPTV tab with that channel selected and the video options shown. It **never starts on its own**; the admin presses Stream. An unknown or stale key shows "That channel is no longer in the playlist" and leaves the IPTV tab open.

**Redirects (old links keep working)**

| Old | New |
|---|---|
| `/media-bots?tab=bots` | `/bot-hub` |
| `/media-bots?tab=queue&bot=N` | `/bot-hub/N` |
| `/media-bots?tab=queue` (no bot) | `/bot-hub` |
| `/media-bots?tab=video&bot=N` | `/bot-hub/N` |
| `/media-bots?tab=video` (no bot) | `/media-bots?tab=streaming` |
| `/media-bots?tab=commands` | `/bots?tab=commands` |
| `/music-bots` | `/media-bots` (unchanged) |

**Unchanged:** Bot Flows, chat commands, every backend media start/stop endpoint, and the single media session rule.

## 2. The console page

### Components (`packages/frontend/src/pages/bot-hub/`)

| Unit | Job |
|---|---|
| `BotConsole.tsx` | Route page: loads the bot, handles not found and offline, lays out the panels |
| `NowPlayingPanel` | Shared now-playing component (full variant). Same component the hub cards use in compact form. The Media Bots → Bots card is not converted: it is removed with that tab |
| `UpNextQueue` | Queue list: drag to reorder, play now, remove, shuffle, repeat (off / track / queue), clear |
| `SourcePicker` | Tab shell; one file per tab: `MusicSource`, `LinkSource`, `RadioSource`, `IptvSource` |
| `VideoOptions` | Quality, encoder, no-viewer timeout, source type. Used by Link (stream as video) and IPTV |

### Tabs

- **Music:** sub-views Songs · Playlists · Recent requests. Search box, pager. Songs: Play / Queue. Playlists: Play (replaces the queue) / Queue (appends). Recent requests: the latest `!play` history (the API returns the newest 100).
- **Link:** YouTube, Twitch, direct URL, or a filename already in the music folder. A clear choice: **Play as music** (`play-url`) or **Stream as video** (`stream/start`). Video options show only for "Stream as video".
- **Radio:** search plus mood chips (All, then each distinct `genre` with a count), Play. Adding and editing stations stays in Media Library → Radio stations, which gains **Edit station**.
- **IPTV:** see "IPTV navigation" below. Video options shown.

### IPTV navigation

Playlists often hold hundreds or thousands of channels, so the IPTV tab is a browser, not a flat list.

- **Views:** Favourites · Recent · Browse groups. Opens on Favourites when there are any, else Browse groups.
- **Browse groups:** every distinct `group-title` across this server's playlists, with channel counts, filterable and paged. Opening a group lists its channels (logo, name, playlist) with the pager, and "← All groups" to go back.
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
- The console reads the `?iptv=` deep link once on load (see IPTV page).
- Both already refresh every 1–3 s, so the panel tracks starts, stops, replacements and auto-stops without a reload.

### Starting and stopping

Existing endpoints only: `play`, `queue`, `queue/playlist`, `play-url`, `play-radio`, `stream/start`, `iptv/stream`, the stop routes, `queue/move` for drag and drop. A conflict goes through the existing global `MediaSwitchDialog` ("Replace what is playing?"). The console adds no switching logic.

When a video replaces music, the backend keeps the queue (`clearPlayback` does not touch it). Up next stays visible and is marked paused until music starts again.

### Now playing by media type

| Type | Shows | Controls |
|---|---|---|
| Music (library, playlist, link) | Title, artist, progress, queue position | Pause, skip, stop, volume, Up next |
| Radio | Station name, the station's ICY "on air" title when it sends one, "plays until stopped" | Stop, volume. Up next collapses to "Up next (n) is kept while the radio plays" with **Play queue** |
| Video / IPTV | Preview, quality, encoder, source, encode health, viewers, auto-stop countdown | Stop, volume |
| Idle | "Nothing is playing" and the last stop reason | — |

Radio plays until stopped (`playStream` does not touch the queue). Like music, it stops by itself when the bot's channel is empty for `BOT_AUTO_STOP_EMPTY_SECONDS` (default 300).

### Bot avatars

TeamSpeak 6 beta13 shows avatars set the TeamSpeak 3 way for a bot identity without a myTeamSpeak account (tested in #259 with `scripts/bot-avatar-test.ts`, #261): upload the image with `ftinitupload name=/avatar cid=0`, then `clientupdate client_flag_avatar=<md5 of image>`.

- **Bot settings** (console header menu) gain **Avatar**: upload an image, use the default, or none.
- **Files:** PNG, JPEG or GIF, at most 200 KB, checked by content (magic bytes), not by extension. No server-side resizing.
- **Default avatar:** a ts6-manager image shipped with the backend. New bots start with **Use default**; existing bots start with **None**, so upgrading changes nothing they show.
- **Applying it:** on every connect, and whenever the avatar changes, the bot uploads the current image, confirms it, then sends `client_flag_avatar`. It always uploads (images are at most 200 KB), because an existence check cannot tell an old image from a new one when the avatar changed while the bot was offline. Choosing **None** sends an empty `client_flag_avatar` and deletes the uploaded file (`ftdeletefile`). `ftgetfileinfo` works on TS6 beta13: the stored name is `/avatar_` followed by the client's unique ID bytes written as letters a–p, one per nibble (verified in #261). `ftdeletefile` is not yet tested; if it is refused, leave the old file in place. TS6 sends no transfer-complete notice, so confirm each upload by checking that the stored size from `ftgetfileinfo` matches the image before setting `client_flag_avatar`.
- **Refused upload** (for example error 2568 when the bot's server group may not upload files): the bot stays connected, the settings show "TeamSpeak refused the avatar upload. Allow file uploads for the bot's server group, or choose None." The web UI still shows the chosen image (next point).
- **Web UI:** Bot Hub cards and the console header show the chosen image, served from the backend, whether TeamSpeak accepted it or refused it.
- Query clients (Bot Flows connections) get no avatar: they are hidden from the channel tree.

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

All long lists use one shared pager: "1–50 of 148", page buttons, and a **Per page** picker (25 / 50 / 100). The per-page choice is remembered for each list in the browser (`localStorage`, wrapped so a blocked store just falls back to 50). On phones the pager collapses to "‹ Page 2 of 3 ›". It reuses the pagination pieces from `DataTable.tsx` rather than a second implementation.

| List | Change |
|---|---|
| Songs | New `GET /songs/search?search=&page=&pageSize=` returning `{ total, page, pageSize, songs }`. `GET /songs` is unchanged, so the Library tab is unaffected |
| Playlists | Filtered and paged in the browser |
| Recent requests | Existing endpoint (newest 100); paged in the browser |
| Radio stations | Filtered by search and mood, paged in the browser |
| IPTV groups | New groups endpoint with counts; paged like the other lists |
| IPTV channels | New cross-playlist search, paged like the per-playlist endpoint |
| Up next | Not paged: the whole queue scrolls inside the panel, so drag and drop works across it |

### Backend changes (complete list)

All new routes use the same middleware as the routes they sit beside (`requireServerAccess` plus the existing role checks), so an account only sees servers it has access to. Every query is scoped to one `serverConfigId`.

1. `GET /songs/search`: paged song search; `GET /songs` unchanged.
2. `GET /api/iptv/groups?serverConfigId=&playlistId=&country=&language=`: distinct groups with channel counts.
3. `GET /api/iptv/channels?serverConfigId=&playlistId=&group=&country=&language=&search=&page=&pageSize=`: cross-playlist channel search.
4. `GET/PUT/DELETE /api/iptv/favourites`: list, add, remove favourites by stable key.
5. `GET /api/iptv/recent`: the last 20 streamed channels; recorded inside the existing IPTV stream start paths (route and `!tv`).
6. `PUT /radio-stations/:id`: edit name, URL and genre, with the same `validateUrl` check as adding a station.
7. `GET /playlists`: optional `serverConfigId` filter; chat `!playlist` stops filtering by `musicBotId`.
8. **Auto-stop notices** (`voice-bot.ts`): when a channel-empty or no-viewer auto-stop fires, the bot posts one line in its channel chat ("Stopped radio: the channel was empty for 5 minutes." / "Stopped the stream: nobody watched for 5 minutes."). For video, `refreshNoViewerTimer` also schedules a warning 60 s before the stop ("Nobody is watching. The stream stops in 1 minute."); it is cancelled if a viewer joins. Skipped when the no-viewer timeout is 60 s or less. All notices go through `sendChannelMessage`, so the existing 524 flood hold applies. Controlled by a per-server **Announce auto-stops in chat** switch (default on) stored with the streaming defaults in `AppSetting`; no migration.
9. **Bot avatars:** `PUT /api/music-bots/:id/avatar` (multipart, one file) stores the image, sets `avatarMode` to `custom`, and applies it if the bot is connected; `PUT /api/music-bots/:id/avatar/mode` with `{ mode: 'custom' | 'default' | 'none' }`; `GET /api/music-bots/:id/avatar` serves the current image (or 404 for none) with `Cache-Control: no-store`, so a shared browser never serves it to another account without a fresh access check. Admin only, audited like other bot settings. Images are stored under the backend data directory as `bot-avatars/<botId>.<version>.<ext>` (a fresh version per upload, so the previous file survives until the database points at the replacement), never at a client-supplied path.
10. Chat command clash check: a read-only list of built-in command names exposed to the frontend (shared constant in `@ts6/common`, no new route).

### Data model changes (SQLite, Prisma migrations)

- `IptvChannel`: add nullable `tvgCountry` and `tvgLanguage`; the M3U parser stores them.
- `MusicBot`: add `avatarMode` (`'none' | 'default' | 'custom'`, default `'none'` for existing rows; new bots created from the UI get `'default'`), `avatarFile` (nullable, relative name under `bot-avatars/`) and `avatarMd5` (nullable).
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

`voice-bot.ts` and sidecar `main.go` splits; framework upgrades; EPG/XMLTV/Xtream; a video library (upload, list, delete); per-user (rather than per-server) favourites; the listener remote (`!remote` one-time link for non-admins, planned as the 1.11.0 lead feature in #253); permissions for built-in chat commands and vote-skip (1.11.0, #254); warnings, automod, leaderboard, self-assign groups and polls (1.12.0, #255); flow templates for support tickets, reminders and announcements (#256); Twitch/YouTube alerts (#257); multiple mood tags per radio station; dynamic quality changes during a stream; the flow loop node.

## 4. PR order

Must-have PRs ship in 1.10.0. "Can slip" PRs ship in 1.10.0 if ready, otherwise in 1.10.x, and never hold the release.

| # | PR | Depends on | 1.10.0 |
|---|----|-----------|--------|
| 0 | Merge release PR #252 (1.9.4) first, if shipping it separately | — | — |
| 0b | Merge #238 (H.264 NVENC, contributor PR) | — | must, before PR 5 |
| 1 | `refactor:` split MusicBots.tsx (R2) | — | must |
| 2 | `refactor:` shared URL pipeline (R1) | — | must |
| 3 | `feat:` edit radio stations (`PUT` route + Edit in Media Library → Radio stations) | — | must |
| 4 | `feat:` playlists shared by all bots on a server (list filter, chat `!playlist`) | — | must |
| 5 | `feat:` announce auto-stops in chat, 1-minute video warning, Streaming defaults switch | — | must |
| 6 | `refactor:` shared NowPlaying component, used by the Bot Hub cards | — | must |
| 7 | `feat:` console page, Now playing, Up next with drag and drop, hub "Open console" (opens the 1.10.0 release PR) | 6 | must |
| 8 | `feat:` console Music tab (Songs · Playlists · Recent) + Radio tab with mood chips, `/songs/search` | 1, 7 | must |
| 9 | `feat:` console Link tab (music or video, music-folder filename) + video options | 7 | must |
| 10 | `feat:` console IPTV tab: group browser, cross-playlist search, playlist filter, `?iptv=` deep link | 7 | must |
| 11 | `feat:` IPTV favourites and recent (migration, routes, views) | 10 | can slip |
| 12 | `feat:` IPTV country and language (migration, parser, filters) | 10 | can slip |
| 13 | `feat:` chat commands move to Bot Flows, built-in list, clash warnings | 1 | must |
| 14 | `feat:` Bot Hub becomes the bot list; Media Library 5 tabs; IPTV "Stream on…"; redirects | 8, 9, 10, 13 | must |
| 15 | `docs:` / `test:` docs, Playwright, upgrade note, 1.10.0 smoke checklist | 14 | must |
| 16 | `refactor:` split chat handler (R3) | 2, 4, 5, 13 | can slip |
| 17 | `feat:` bot avatars (per-bot, default for new bots, re-applied on connect) | 7 | can slip |

PRs 1–6 have no dependencies and can run side by side. R3 runs last because PRs 2, 4, 5 and 13 all edit `music-command-handler.ts` or `voice-bot.ts`; splitting that file in parallel would cause constant conflicts.

PR 14 uses `feat:`, not `feat!:`: old URLs redirect and no API changes, so a `!` (which would bump to 2.0.0) is wrong.

**Keeping `main` releasable.** PR 7 adds the console alongside the existing pages, so `main` works at every step. Avoid merging the release PR between PR 7 and PR 14. If an urgent fix forces a release in that window, it ships as 1.10.0 with the console added and the old pages still present, which is safe.

## 5. Testing

**Unit (frontend):** source-to-request mapping for each tab (Music views, Link as music vs video, filename vs URL, Radio, IPTV, video options); the redirect table; the `?iptv=` deep link pre-selects but never starts, and handles a stale key.

**Unit (backend):** R1 characterization tests (web and chat); `/songs/search` paging and `/songs` unchanged; new routes refuse a server the account has no access to; IPTV groups and cross-playlist search (counts, filters, paging, admin only, scoped to one server); M3U parser stores `tvg-country` and `tvg-language`; favourites and recents survive a playlist refresh via stable keys, show "No longer in this playlist" when a channel disappears, and recent is capped at 20; radio station edit validates the URL like add does; auto-stop notices fire once per stop, the video warning fires 60 s early and is cancelled when a viewer joins, nothing is sent when the switch is off, and notices respect the flood hold; `GET /playlists` filters by server and chat `!playlist` lists every playlist on the server regardless of `musicBotId`; R3 keeps existing chat command tests green.

**Unit (backend), avatars:** content-type sniffing rejects a renamed non-image and files over 200 KB; upload, flag and delete commands are sent in order; reconnect re-uploads, confirms the stored size and re-sends the flag; an upload sets `avatarMode` to `custom` and a reconnect keeps applying that image; an image changed while the bot was offline replaces the old remote file; `GET` answers with `Cache-Control: no-store`; a 2568 refusal keeps the bot connected and records the message; `None` clears the flag and deletes the file; images are written only under `bot-avatars/`.

**Unit (frontend), commands:** clash detection across custom replies, flow command triggers and built-in names.

**Playwright (docs mode):** new `bot-console.spec.ts` covering open from hub, start each media type, the replace prompt then replace, stop, drag-and-drop reorder (mouse and keyboard), remove, and phone width. Update `bot-hub.spec.ts`, `sidebar.spec.ts`, `docs-screenshots.spec.ts`, `bot-flow.spec.ts` (Chat commands tab); re-check `iptv-local-hosts.spec.ts`.

**Before every push:** `pnpm typecheck`, backend and frontend unit tests, the Playwright suite, and `go test` when a PR touches the sidecar. Node 20 and pnpm 9 per AGENTS.md.

## 6. Docs

- `docs/music-bots.md`: Bot Hub and console, Media Library tabs, shared playlists.
- `docs/bot-flows.md`: Chat commands tab, built-in list, clash warnings.
- `docs/video-streaming.md` and the IPTV section: starting from the console; filename sources via the Link tab.
- `docs/video-streaming.md` and `docs/music-bots.md`: auto-stop chat notices, the 1-minute video warning and the switch that turns them off.
- `docs/roadmap.md`: 1.10.0 entry.
- `docs/music-bots.md`: bot avatars, the default avatar, and the server-group file-upload permission they need.
- `docs/upgrading.md`: back up the database before upgrading to 1.10.0 (SQLite migrations: IPTV country/language columns, `IptvChannelPick` and the `MusicBot` avatar columns).
- New `docs/plans/164-1-10-0-rc-smoke.md`, run in the homelab before the release PR merges (VAAPI on the AMD GPU; NVENC if #238 lands).

## Acceptance

- [ ] From one bot's console you can start music, a link (as music or video), radio and IPTV. A second start prompts first, then replaces the current session.
- [ ] Now playing and Up next match the bot's real state after a start, stop, replacement or auto-stop, without a reload.
- [ ] Up next reorders by drag and drop with mouse, touch and keyboard.
- [ ] IPTV: browse by group across playlists, search, and filter by playlist. "Stream on…" opens the console with the channel selected, without starting it.
- [ ] IPTV (can slip): star favourites and see recent channels, which survive a playlist refresh; filter by country and language.
- [ ] Radio: filter stations by mood; edit an existing station's mood; Now playing shows the station (no progress or skip) and offers Play queue.
- [ ] Long lists page with 25 / 50 / 100 per page, remembered per list.
- [ ] Auto-stops are announced in channel chat, with a 1-minute warning before a no-viewer video stop, unless the switch is off.
- [ ] Bot Hub is the only bot list; Media Library has 5 tabs; Bot Flows has Flows · Chat commands; every old link in the redirect table lands correctly.
- [ ] Every bot on a server sees the same songs, playlists, radio stations and IPTV channels, in the console and in chat.
- [ ] A clashing command name shows a warning on the Chat commands tab and in the flow editor.
- [ ] The console is usable at phone width.
- [ ] (can slip) A bot's avatar set in the console shows in the TeamSpeak 6 client after connect and after a reconnect; new bots get the default; a refused upload shows the message and the bot stays connected.
- [ ] R1 and R2 land with no behaviour change (characterization tests and existing tests green).
- [ ] Docs, the upgrade backup note and the 1.10.0 smoke checklist cover the release.
