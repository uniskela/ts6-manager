# 1.10.0 Bot Console, Phase 2 Implementation Plan (PRs 7–17)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Each task is one PR**, branched from current `main`. Start a task only when every task in its "Depends on" line has merged.

**Goal:** Build the per-bot console and the 1.10.0 UI restructure: console page, its tabs, IPTV navigation, chat commands in Bot Flows, Bot Hub as the one bot list, and bot avatars.

**Architecture:** Task 7 lays the foundation (route, panels, shared pager and video options) and the later tabs plug into its `SourcePicker`. Backend additions are small, admin-only, server-scoped routes. Task 14 removes the old flows only after every console tab exists, so `main` stays releasable throughout.

**Tech Stack:** TypeScript monorepo (pnpm 9): `packages/backend` (Express, Prisma/SQLite, `node:test` via `tsx --test`), `packages/frontend` (React 18, React Router 6, TanStack Query 5, Tailwind/shadcn, Playwright), `packages/common` (shared types).

**Spec:** `docs/superpowers/specs/2026-10-02-bot-console-1-10-0-design.md` (sections 1, 2 and 4). Mockup: the private design canvas linked from #164.

## Who builds what

| Task | PR | Owner | Effort | Depends on |
|---|---|---|---|---|
| 7 | Console page, Now playing (full), Up next drag and drop, shared Pager and VideoOptions, hub "Open console" | **Claude** | High | — |
| 8 | Music tab (Songs · Playlists · Recent) + Radio tab (moods), `GET /songs/search` | **Cursor** | Low | 7 |
| 9 | Link tab (music or video, music-folder filename) | **Cursor** | Low | 7 |
| 10 | IPTV tab: groups, cross-playlist search, playlist filter, `?iptv=` deep link | **Codex** | Medium | 7 |
| 11 | IPTV favourites + recent (migration) | **Codex** | Medium | 10 |
| 12 | IPTV country + language (migration, parser) | **Codex** | Medium | 10 |
| 13 | Chat commands move to Bot Flows, built-in list, clash warnings | **Codex** | Medium | — |
| 14 | Bot Hub becomes the bot list; Media Library 5 tabs; IPTV "Stream on…"; redirects | **Claude** | High | 8, 9, 10, 13 |
| 15 | Docs, Playwright, `docs/plans/164-1-10-0-rc-smoke.md`, upgrade note | **Cursor** | Low | 14 |
| 16 | R3: split `music-command-handler.ts` | **Codex** | High | phase 1 Tasks 4 and 5, Task 13 |
| 17 | Bot avatars | **Codex** | High | 7 |

Can slip to 1.10.x without holding the release: 11, 12, 16, 17.

## Global Constraints

- Node.js 20, pnpm 9.15.9. `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm --filter @ts6/common build`.
- Follow `AGENTS.md`: Conventional Commit PR titles (`feat:` for user-visible work, `refactor:` for 16, `docs:` for 15). Never `feat!:`. Never edit package versions, `version.txt`, `app-version.ts` or `CHANGELOG.md`.
- One PR per task, branched from `main`. Do not stack tasks.
- Before every push: `pnpm typecheck`; backend tests you touched (`cd packages/backend && pnpm exec tsx --test <files>`); frontend unit tests (`cd packages/frontend && pnpm exec tsx --test tests/unit/*.test.ts`); Playwright for frontend changes (`pnpm --filter @ts6/frontend test`).
- New routes reuse the middleware of the router they join (`requireServerAccess`, role checks) and scope every query to one `serverConfigId`.
- Admin-only pages stay behind `AdminRoute`. Every console start/stop uses the existing endpoints; conflicts go through the existing global `MediaSwitchDialog`. No new switching logic.
- Touch targets at least 44 px; usable at 390 px wide; icon-only buttons have `aria-label`s that name the item ("Remove Song title").
- User-facing copy is exactly as written in the spec or this plan.

## Review Focus

1. **Queue indexes.** `PlaybackState.queue` holds the whole queue and `currentIndex` points at the playing track. Up next shows `queue.slice(currentIndex + 1)`; every move, remove or play-now converts the Up next position back to the absolute index (`currentIndex + 1 + i`). An off-by-one here moves the wrong song. Test in Task 7.
2. **Stale queue while dragging.** The queue refreshes every 2 s. A drop must use the indexes from the moment the drag started and the UI must not jump back while the move request is in flight (optimistic order, then refetch). Test in Task 7.
3. **Bot not found / offline / no server access.** `/bot-hub/999` shows "Bot not found" with a link back; an offline bot disables the source tabs with "Start the bot to play something". Test in Task 7.
4. **Deep links never start media.** `?iptv=` (Task 10) and the redirects (Task 14) only pre-select; an admin always presses Play/Stream. Test in Tasks 10 and 14.
5. **Old links.** Every row of the spec's redirect table lands on the right page (Task 14).

---

### Task 7 (Claude): `feat: bot console page with now playing and drag-and-drop queue`

**Files:**
- Create `packages/frontend/src/pages/bot-hub/BotConsole.tsx` (route page), `UpNextQueue.tsx`, `SourcePicker.tsx`, `console-queue.ts` (pure index helpers).
- Create `packages/frontend/src/components/shared/Pager.tsx` and `packages/frontend/src/lib/pager.ts` (pure paging + remembered page size).
- Create `packages/frontend/src/components/video/VideoOptions.tsx`.
- Modify `packages/frontend/src/components/media/NowPlaying.tsx` (`full` variant), `packages/frontend/src/pages/BotHub.tsx` ("Open console"), `packages/frontend/src/App.tsx` (route `/bot-hub/:botId`).
- Add dependencies `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` to `packages/frontend` (pnpm 9, lockfile updated).
- Test: `packages/frontend/tests/unit/console-queue.test.ts`, `packages/frontend/tests/unit/pager.test.ts`, `packages/frontend/tests/bot-console.spec.ts`.

**Interfaces (produced, used by Tasks 8–10, 14, 17):**
```ts
// pages/bot-hub/console-queue.ts
export function upNext(state: Pick<PlaybackState, 'queue' | 'currentIndex'>): QueueItemInfo[];
export function absoluteIndex(currentIndex: number, upNextIndex: number): number; // currentIndex + 1 + upNextIndex
export function moveUpNext<T>(items: T[], from: number, to: number): T[];        // optimistic reorder

// pages/bot-hub/SourcePicker.tsx
export interface ConsoleSourceTab {
  id: 'music' | 'link' | 'radio' | 'iptv';
  label: string;
  render: (ctx: ConsoleSourceContext) => React.ReactNode;
}
export interface ConsoleSourceContext {
  botId: number;
  serverConfigId: number;
  botOnline: boolean;
  searchParams: URLSearchParams; // for deep links (Task 10)
}
export function SourcePicker(props: { tabs: ConsoleSourceTab[]; ctx: ConsoleSourceContext; initialTab?: ConsoleSourceTab['id'] }): JSX.Element;
// BotConsole opens the IPTV tab when `?iptv=` is present.
// BotConsole keeps a `CONSOLE_TABS: ConsoleSourceTab[]` array; Tasks 8–10 each append one entry.

// components/shared/Pager.tsx + lib/pager.ts
export function pageSlice<T>(items: T[], page: number, pageSize: number): T[];
export function pageCount(total: number, pageSize: number): number;
export type PageSize = 25 | 50 | 100;
export function pageRangeLabel(total: number, page: number, pageSize: number, noun: string): string;
export function rememberedPageSize(listKey: string, fallback?: PageSize): PageSize; // localStorage, try/catch
export function rememberPageSize(listKey: string, size: PageSize): void;
export function Pager(props: { listKey: string; total: number; page: number; pageSize: PageSize;
  noun: string; onPageChange(p: number): void; onPageSizeChange(s: PageSize): void }): JSX.Element;
// Renders "1–50 of 148 {noun}", page buttons, Per page 25/50/100; "‹ Page 2 of 3 ›" under 640 px.

// lib/video-options.ts + components/video/VideoOptions.tsx  (as built in PR #275)
export interface VideoStartOptions { quality: VideoQualityRequest; encoder: VideoEncoderRequest | 'default';
  noViewerTimeout: string /* 'default' | '0' | seconds */; sourceMode: VideoSourceModeRequest; }
export const DEFAULT_VIDEO_START_OPTIONS: VideoStartOptions;
export function videoStartRequest(o: VideoStartOptions):
  Pick<StartVideoStreamRequest, 'preset' | 'encoder' | 'noViewerTimeoutSec' | 'sourceMode'>; // spread into stream/start
export function VideoOptions(props: { value: VideoStartOptions; onChange(v: VideoStartOptions): void }): JSX.Element;
// "default" choices leave quality/encoder/timeout to the server's streaming defaults.
```

- [ ] **Step 1: Failing unit tests** (`console-queue.test.ts`): `upNext` returns items after `currentIndex` (and the whole queue when `currentIndex` is -1); `absoluteIndex(2, 0) === 3`; `moveUpNext` moves an item down and up and leaves other items in order (Review Focus 1). `pager.test.ts`: `pageSlice` first/middle/last page, `pageCount(148, 50) === 3`, `rememberedPageSize` falls back to 50 when storage throws.
- [ ] **Step 2:** Run them. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the helpers. Run. Expected: PASS.
- [ ] **Step 4:** Add the route `/bot-hub/:botId` behind `AdminRoute`; `BotConsole` reads the bot from `useBotMedia()` (filter by `botId`) and `useMusicBotState(botId)`. Header: name, server, channel, connection badge. Left: `NowPlaying variant="full"` (music: progress, pause/skip/stop, volume; radio: station + ICY title, Stop, "plays until stopped"; video: as the hub card plus quality/encoder/health/viewers/auto-stop; idle: "Nothing is playing." + last stop) and `UpNextQueue`. Right: `SourcePicker` with `CONSOLE_TABS = []` and the empty state "Sources arrive in the next 1.10.0 updates." while no tab is registered.
- [ ] **Step 5:** `UpNextQueue`: dnd-kit sortable list with a drag handle (`aria-label="Drag to reorder {title}"`), keyboard sensor, play-now and remove buttons per row, Shuffle, Repeat (off/track/queue), Clear. Drop → optimistic `moveUpNext`, then `useMoveQueueItem({ botId, from: absoluteIndex(...), to: absoluteIndex(...) })` (Review Focus 2). While radio or video plays: "Up next (n) is kept while the radio plays." / "…while the video plays." with **Play queue** (`usePlayFromQueue` at the first Up next item).
- [ ] **Step 6:** Edge cases: unknown bot → "Bot not found" + link to `/bot-hub`; offline bot → source tabs disabled with "Start the bot to play something" (Review Focus 3).
- [ ] **Step 7:** Bot Hub cards: the footer's "Open" button becomes "Open console" → `/bot-hub/{botId}`.
- [ ] **Step 8:** Playwright `bot-console.spec.ts` (docs mode fixtures): open console from the hub; Up next shows the right items; keyboard reorder sends `from`/`to` absolute indexes; remove sends the absolute index; unknown bot page; 390 px has no horizontal scroll.
- [ ] **Step 9:** `pnpm typecheck`, unit tests, Playwright. Commit, push, open the PR.

### Task 8 (Cursor): `feat: console music and radio tabs`
**Depends on:** 7. **Files:** `pages/bot-hub/MusicSource.tsx`, `RadioSource.tsx`, register both in `CONSOLE_TABS`; backend `GET /api/servers/:configId/music-library/songs/search?search=&page=&pageSize=` returning `{ total, page, pageSize, songs }` in `music-library.routes.ts` + test.
- [ ] Backend test first: search matches title or artist (case-insensitive), pages correctly, `pageSize` capped at 100, other servers' songs never returned; `/songs` unchanged.
- [ ] Music tab: sub-views **Songs · Playlists · Recent requests** (reuse `PlaySongDialog` pieces from `pages/media-bots/`), search box, `Pager` (`listKey` `console-songs` / `console-playlists` / `console-recent`). Songs: Play / Queue. Playlists: Play (replaces queue, `useLoadPlaylist` with `clearFirst: true`) / Queue (append). Recent: newest 100 from the existing requests endpoint, paged in the browser.
- [ ] Radio tab: search + mood chips (All + each distinct `genre` with count), `Pager`, Play (`play-radio`). Footer: "Moods come from each station's genre. Set or change it under Media Library → Radio stations."
- [ ] Playwright: play a song, queue a playlist, filter radio by mood.

### Task 9 (Cursor): `feat: console link tab`
**Depends on:** 7. **Files:** `pages/bot-hub/LinkSource.tsx`, register in `CONSOLE_TABS`.
- [ ] Input label "YouTube, Twitch, direct link, or a file already in the music folder". Radio choice **Play as music** (`play-url`) / **Stream as video** (`stream/start` with `VideoOptions`). Start button text follows the choice.
- [ ] Unit test the request mapping (URL vs filename; music vs video; video options passed through).
- [ ] Playwright: both choices send the right request; a conflict opens "Replace what is playing?".

### Task 10 (Codex): `feat: console IPTV tab with groups and search`
**Depends on:** 7. **Files:** `pages/bot-hub/IptvSource.tsx`; backend `GET /api/iptv/groups` and `GET /api/iptv/channels` per spec section 2 "Backend changes" 2–3, in `iptv.routes.ts` + tests.
- [ ] Backend tests first: groups with counts across all playlists of one server; channel search by name, group, playlist; paging; another server's data never returned.
- [ ] Views: Browse groups (paged, filterable) → group channels (logo, name, playlist, Stream) with "← All groups"; search all or within group; Playlist filter. `VideoOptions` shown.
- [ ] Deep link `?iptv=<playlistId>:<channelKey>` selects the channel and opens the IPTV tab; it **never starts** a stream; a stale key shows "That channel is no longer in the playlist" (Review Focus 4).
- [ ] Playwright: browse a group, search, deep link pre-selects without a stream request.

### Task 11 (Codex): `feat: IPTV favourites and recent channels`
**Depends on:** 10. Migration `IptvChannelPick` and routes 4–5 exactly as the spec's "Data model changes" and "IPTV navigation". Tests: stable key survives a playlist refresh (channel IDs change); "No longer in this playlist" with Remove; recent capped at 20; recorded from console, IPTV page and `!tv`. UI: Favourites · Recent views and a star on each channel row.

### Task 12 (Codex): `feat: filter IPTV channels by country and language`
**Depends on:** 10. Migration adding nullable `tvgCountry`, `tvgLanguage` to `IptvChannel`; `m3u-parser.ts` stores `tvg-country` / `tvg-language`; filters split on `;` and `,`; Country/Language selects appear only when values exist. Tests for parser and filters.

### Task 13 (Codex): `feat: move chat commands to Bot Flows with clash warnings`
**Depends on:** — (phase 1 Task 1 is merged). Move `pages/media-bots/CommandsTab.tsx` into Bot Flows as tab **Chat commands** (`/bots?tab=commands`), unchanged behaviour. Add a read-only built-in command list from a shared constant in `@ts6/common`. Clash warnings (custom reply vs flow command trigger vs built-in) on the tab and in the flow editor's command trigger. Text: "Custom replies are answered by media bots in their command channels; flows run in the flow engine." Unit-test clash detection. Leave the Media Bots tab in place; Task 14 removes it.

### Task 14 (Claude): `feat: Bot Hub becomes the bot list and Media Bots becomes Media Library`
**Depends on:** 8, 9, 10, 13. Bot Hub gains New bot / edit / delete / start-stop / widget link (from `pages/media-bots/BotsTab.tsx` and `BotPlayerCard`); console header settings menu; sidebar label "Media Library"; Media Library tabs Library · Playlists · Radio stations · Requests · Streaming defaults; remove Bots, Queue, Video stream controls and Commands tabs; IPTV "Stream on…"; the spec's redirect table (Review Focus 5); `docs-screenshots` refresh.

### Task 15 (Cursor): `docs: 1.10.0 console docs, smoke checklist and upgrade note`
**Depends on:** 14. Spec section 6 "Docs" in full, plus `docs/plans/164-1-10-0-rc-smoke.md` built from issue #271.

### Task 16 (Codex): `refactor: split the chat command handler`
**Depends on:** phase 1 Tasks 4 and 5, Task 13. Spec section 3 "R3". No behaviour change; existing chat tests unchanged and green.

### Task 17 (Codex): `feat: bot avatars`
**Depends on:** 7. Spec section 2 "Bot avatars" and "Backend changes" 9, data model columns, tests in section 5. Reuse the upload/confirm logic proven in `packages/backend/scripts/bot-avatar-test.ts`.
