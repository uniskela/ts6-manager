# 1.10.0 Bot Console, Phase 1 Implementation Plan (PRs 1–6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Each task is one PR**, branched from current `main`, and the tasks do not depend on each other.

**Goal:** Land the six independent groundwork PRs for 1.10.0: two refactors, three small features, and the shared now-playing component.

**Architecture:** Each task is self-contained and mergeable on its own. Refactors (Tasks 1, 2, 6) must not change behaviour. Features (Tasks 3, 4, 5) add backend behaviour with tests first, then the smallest UI needed.

**Tech Stack:** TypeScript monorepo (pnpm workspaces): `packages/backend` (Express, Prisma on SQLite, `node:test` via `tsx --test`), `packages/frontend` (React, Vite, TanStack Query, Playwright), `packages/common` (shared types).

**Spec:** `docs/superpowers/specs/2026-10-02-bot-console-1-10-0-design.md` (read sections 1, 2 "Backend changes", 3 and 4 first). Phase 2 (PRs 7–16) gets its own plan after these land.

## Global Constraints

- Node.js 20 and pnpm 9.15.9 (`corepack prepare pnpm@9.15.9 --activate`). Do not use a newer pnpm major. Install with `pnpm install --frozen-lockfile`, then `pnpm db:generate` and `pnpm --filter @ts6/common build`.
- Follow `AGENTS.md`: Conventional Commit PR titles (`refactor:` for Tasks 1, 2, 6; `feat:` for Tasks 3, 4, 5). Never `feat!:`. Never edit package versions, `version.txt`, `app-version.ts` or `CHANGELOG.md`.
- One PR per task, branched from `main`, base `main`. Do not stack tasks on each other.
- Before every push: `pnpm typecheck`, the backend test files you touched (`cd packages/backend && pnpm exec tsx --test <files>`), frontend unit tests (`cd packages/frontend && pnpm exec tsx --test tests/unit/*.test.ts`), and for frontend changes `pnpm --filter @ts6/frontend test` (Playwright).
- New or changed routes keep the middleware of the router they live in (`requireServerAccess` and role checks) and scope every query to the route's `serverConfigId`.
- Chat messages from bots go through `VoiceBot.sendChannelMessage` / `sendTextMessage` only, so the existing antiflood (524) hold applies.
- User-facing copy is exactly as written in this plan.

## Review Focus

1. **Radio edit with a blocked URL** (private IP, `file:`, metadata host): the API answers 400 with the same message as adding, and the station is unchanged. Test in Task 3.
2. **Radio edit of another server's station** (right ID, wrong `serverConfigId` in the path): 404, nothing changes. Test in Task 3.
3. **Legacy playlists with `serverConfigId = null`**: they must stay visible (treat as shared on every server), not vanish from the console or chat. Test in Task 4.
4. **Viewer joins after the 1-minute warning**: the stream keeps running and no stop notice is sent. With a no-viewer timeout of 60 s or less, no warning is sent at all. Test in Task 5.
5. **Announcements switched off, or a 524 flood hold active**: nothing is sent directly; with the switch off nothing is sent at all. Test in Task 5.

---

### Task 1 (PR 1): `refactor: split MusicBots page into one file per tab`

**Files:**
- Create: `packages/frontend/src/pages/media-bots/` with `MusicBots.tsx` (page shell, default export), `BotsTab.tsx`, `BotPlayerCard.tsx`, `QueueTab.tsx`, `VideoTab.tsx`, `LibraryTab.tsx`, `PlaylistsTab.tsx`, `CommandsTab.tsx`, `RadioTab.tsx`, `PlaySongDialog.tsx`, `ImportQueueOptions.tsx`, and `shared.ts` for helpers used by more than one tab.
- Delete: `packages/frontend/src/pages/MusicBots.tsx`
- Modify: `packages/frontend/src/App.tsx` (lazy import path `@/pages/media-bots/MusicBots`)

**Interfaces:**
- Produces: `PlaySongDialog` and `ImportQueueOptions` as named exports (phase 2 reuses `PlaySongDialog` pieces in the console Music tab). Each tab is a named export with the same name as today (`BotsTab`, `QueueTab`, …).

- [ ] **Step 1:** Move each top-level component from `MusicBots.tsx` (`BotPlayerCard` at line 255, `PlaySongDialog` 555, `BotsTab` 740, `LibraryTab` 1076, `PlaylistsTab` 1592, `CommandsTab` 2569, `RadioTab` 3023, `VideoTab` 3305, `QueueTab` 3385, page 3563) into its file unchanged. Only imports and `export` keywords change.
- [ ] **Step 2:** Run `pnpm typecheck`. Expected: no errors.
- [ ] **Step 3:** Run `git diff -M --stat main` and confirm the moved code is the same (no logic edits). Run frontend unit tests and Playwright. Expected: all pass, including `bot-hub.spec.ts` and `docs-screenshots.spec.ts`.
- [ ] **Step 4:** Commit, push, open the PR. Body: "Pure move, no behaviour change. Part of #196 (1.10.0 plan)."

### Task 2 (PR 2): `refactor: share one media URL pipeline between web play-url and chat !play`

**Files:**
- Create: `packages/backend/src/voice/media-url-pipeline.ts`, `packages/backend/src/voice/media-url-pipeline.test.ts`
- Modify: `packages/backend/src/routes/music-bots.routes.ts:358-560` (`POST /:id/play-url`), `packages/backend/src/voice/music-command-handler.ts` (`enqueueMediaUrl`, around line 1978)

**Interfaces:**
- Produces:
  ```ts
  export interface MediaUrlPipelineDeps {
    resolveSpotify(url: string): Promise<string>;            // today: resolveSpotifyToYouTube
    resolveAppleMusic(url: string): Promise<AppleMusicResolved>;
    appleTrackToYouTube(track: AppleMusicTrack): Promise<string | null>;
    expandYouTube(url: string, cap: number): Promise<{ title?: string; urls: string[] } | null>;
    downloadTrack(url: string): Promise<QueueItem>;        // download into MUSIC_DIR, return the queue item
  }
  export interface MediaUrlRequest { url: string; enqueueOnly: boolean; cap?: number /* default 25 */ }
  export interface MediaUrlTarget {                        // the bot side, so tests can fake it
    play(item: QueueItem, opts: { replaceSessionIds?: string[] }): Promise<void>;
    enqueue(item: QueueItem): void;
    isIdle(): boolean;                                     // first track ended before the next was ready
  }
  export async function runMediaUrlPipeline(
    deps: MediaUrlPipelineDeps, target: MediaUrlTarget, req: MediaUrlRequest,
    opts?: { replaceSessionIds?: string[]; onBackgroundError?: (err: Error, label: string) => void },
  ): Promise<{ first: QueueItem; playlistTitle?: string; queuedInBackground: number }>;
  export function defaultMediaUrlDeps(): MediaUrlPipelineDeps;  // wires today's real functions
  ```
- `QueueItem`, `AppleMusicTrack`, `AppleMusicResolved` are the existing types; import them, do not redefine.

- [ ] **Step 1: Write characterization tests** in `media-url-pipeline.test.ts` with fake deps and a fake target, one per current behaviour of both callers:
  - `single YouTube URL plays immediately` → `target.play` called once, `enqueue` never.
  - `enqueueOnly never starts playback` → `play` never called, every track `enqueue`d.
  - `YouTube playlist plays first, queues the rest in order, capped at 25` → with 30 expanded URLs: 1 `play`, 24 `enqueue` calls, `queuedInBackground === 24`.
  - `Apple Music resolves each track via YouTube search; unmatched tracks are skipped` → a `null` from `appleTrackToYouTube` for track 3 means no enqueue for it and `onBackgroundError` called once.
  - `first track ended before the next was ready resumes playback` → `isIdle()` true when track 2 lands → `play` called for track 2 (not when `enqueueOnly`).
  - Error copy (assert exact strings): no tracks from Apple Music → `Could not resolve any tracks from that Apple Music URL`; empty playlist → `Could not resolve any videos from that playlist URL`; unresolvable YouTube → `Could not resolve that YouTube URL`.
- [ ] **Step 2:** Run `cd packages/backend && pnpm exec tsx --test src/voice/media-url-pipeline.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `runMediaUrlPipeline` by moving the shared logic out of the two callers. Keep each caller's own error type: the route maps pipeline errors to `AppError(502, message)`, chat replies with the message. Keep logging prefixes (`[MusicCmd]`) in the chat wrapper.
- [ ] **Step 4:** Run the new test file plus the existing music tests (`grep -l "play-url\|enqueueMediaUrl" src/**/*.test.ts`). Expected: all PASS.
- [ ] **Step 5:** Run `pnpm typecheck`. Commit, push, open the PR. Body: "No behaviour change; characterization tests pin both callers."

### Task 3 (PR 3): `feat: edit radio stations`

**Files:**
- Modify: `packages/backend/src/routes/radio-stations.routes.ts` (add `PUT /:id` after `POST /`, line ~50)
- Create: `packages/backend/src/routes/radio-stations.edit.test.ts` (follow the setup in `music-bots.volume.test.ts`)
- Modify: `packages/frontend/src/api/music.api.ts` (`radioStationsApi.update`), the radio hooks file (add `useUpdateRadioStation`), and the Radio tab (`RadioTab` in `pages/MusicBots.tsx`, or `pages/media-bots/RadioTab.tsx` if Task 1 has merged)

**Interfaces:**
- Produces: `PUT /api/servers/:configId/radio-stations/:id` body `{ name?: string; url?: string; genre?: string | null }` → `200` with the updated station. `radioStationsApi.update(configId: number, id: number, data: { name?: string; url?: string; genre?: string | null })`. `useUpdateRadioStation()` mutation invalidating the same query keys as add/delete.

- [ ] **Step 1: Write failing tests:**
  - `updates name, url and genre` → 200, row changed.
  - `rejects a blocked url with the add-station message` → private IP URL → 400, row unchanged (Review Focus 1).
  - `404 for a station on another server` (Review Focus 2).
  - `empty genre clears it` → `genre: ''` stores `null`.
  - `400 when name is empty after trim`.
- [ ] **Step 2:** Run the test file. Expected: FAIL (404 route missing).
- [ ] **Step 3:** Implement the route with the same `validateUrl(url, { allowedProtocols: ['http:', 'https:'] })` call and audit call (if any) as `POST /`. Look the station up with `{ id, serverConfigId }`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** UI: an **Edit** button on each station row opens the existing add-station form pre-filled; title "Edit station", submit label "Save". The genre field label becomes "Mood or genre" with placeholder "Chill, Focus, Party…". Toast on success: "Station updated".
- [ ] **Step 6:** `pnpm typecheck`, frontend unit tests, Playwright. Commit, push, open the PR.

### Task 4 (PR 4): `feat: share playlists across all bots on a server`

**Files:**
- Modify: `packages/backend/src/routes/playlists.routes.ts:51-65` (`GET /`), `packages/backend/src/voice/music-command-handler.ts:2146` (`handlePlaylist` where clause)
- Create: `packages/backend/src/routes/playlists.scope.test.ts`
- Modify: `packages/frontend/src/hooks/use-playlists.ts`, `packages/frontend/src/api/music.api.ts` (`playlistsApi.list`), callers of `usePlaylists`

**Interfaces:**
- Produces: `GET /playlists?serverConfigId=N` returns playlists where `serverConfigId = N` **or** `serverConfigId IS NULL` (legacy rows stay visible everywhere). Without the parameter it behaves as today. `musicBotId` is ignored for listing. `usePlaylists(serverConfigId?: number)` (query key `['playlists', serverConfigId]`) replaces `usePlaylists(musicBotId?)`. Chat `!playlist` uses `{ OR: [{ serverConfigId }, { serverConfigId: null }] }`.

- [ ] **Step 1: Write failing tests:** `lists only this server's playlists plus legacy ones` (Review Focus 3); `ignores musicBotId`; `no parameter returns all (unchanged)`; chat: `!playlist lists a playlist tied to another bot on the same server`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the backend changes; update `usePlaylists` callers to pass the selected server (`useServerStore().selectedConfigId` or the dialog's chosen server).
- [ ] **Step 4:** Run tests, `pnpm typecheck`, Playwright. Expected: PASS.
- [ ] **Step 5:** Add one line to `docs/music-bots.md` (Playlists section): "Playlists are shared by every media bot on the same TeamSpeak server." Commit, push, open the PR. Body notes the one visible change: `!playlist` may list more playlists than before.

### Task 5 (PR 5): `feat: announce auto-stops in chat with a 1-minute video warning`

**Files:**
- Modify: `packages/common/src/types/music.ts:354` (`VideoStreamSettings`: add `announceAutoStops: boolean`)
- Modify: `packages/backend/src/utils/app-settings.ts` (default `true`; parse a stored key next to `VIDEO_NO_VIEWER_TIMEOUT_KEY`, same naming style; include in server overrides)
- Modify: `packages/backend/src/voice/streaming/lifecycle.ts` (notice copy), `packages/backend/src/voice/voice-bot.ts` (auto-stop paths ~line 460, `refreshNoViewerTimer` ~1556, `clearNoViewerTimer` ~1544)
- Test: `packages/backend/src/voice/streaming/lifecycle.test.ts` (create or extend), and the existing no-viewer timer test file (`grep -l "noViewer" packages/backend/src/**/*.test.ts`)
- Modify: `packages/frontend/src/components/video/VideoStreamDefaultsCard.tsx` (switch)

**Interfaces:**
- Produces in `lifecycle.ts`:
  ```ts
  export type AutoStopMedia = 'music' | 'radio' | 'video';
  export function autoStopNotice(media: AutoStopMedia, reason: 'channel_empty' | 'no_viewers', seconds: number): string;
  export function noViewerWarningNotice(): string;   // "Nobody is watching. The stream stops in 1 minute."
  export function formatStopDuration(seconds: number): string; // 300 → "5 minutes", 60 → "1 minute", 45 → "45 seconds"
  ```
- Copy (exact): music `Stopped the music: the channel was empty for {d}.`; radio `Stopped radio: the channel was empty for {d}.`; video `Stopped the stream: nobody watched for {d}.`
- Switch label in Streaming defaults: "Announce auto-stops in chat", help text "Posts one line in the bot's channel when it stops by itself, and warns 1 minute before stopping a stream nobody is watching."

- [ ] **Step 1: Write failing tests** for the copy: `formatStopDuration(300) === '5 minutes'`, `(60) === '1 minute'`, `(45) === '45 seconds'`, `(90) === '90 seconds'`; each `autoStopNotice` string exactly as above.
- [ ] **Step 2: Write failing timer tests** (use `node:test` mock timers, as the existing timer tests do):
  - `warns 60 s before a no-viewer stop` → one `sendChannelMessage(noViewerWarningNotice())` at `timeout - 60` s, then the stop notice at `timeout`.
  - `viewer joining after the warning cancels the stop and sends nothing more` (Review Focus 4).
  - `no warning when the timeout is 60 s or less` (Review Focus 4).
  - `nothing is sent when announceAutoStops is false` (Review Focus 5).
  - `channel-empty stop of radio sends the radio notice once`; same for music.
  - `notices use sendChannelMessage` (spy; no direct client send) (Review Focus 5).
- [ ] **Step 3:** Run both test files. Expected: FAIL.
- [ ] **Step 4:** Implement. Radio is `this._isStreaming` music (set by `playStream`). In the channel-empty music branch, read the switch via `await this.loadVideoSettings()`; in the video branch use `this._videoSettings`. Add `_noViewerWarnTimer`, cleared in `clearNoViewerTimer`.
- [ ] **Step 5:** Run tests, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Add the switch to `VideoStreamDefaultsCard`. Document it in `docs/video-streaming.md` (auto-stop section) and `docs/music-bots.md`. Run Playwright. Commit, push, open the PR.

### Task 6 (PR 6): `refactor: shared NowPlaying component for Bot Hub cards`

**Files:**
- Create: `packages/frontend/src/components/media/NowPlaying.tsx`
- Modify: `packages/frontend/src/pages/BotHub.tsx` (`SessionCard`, lines ~56–175)

**Interfaces:**
- Produces:
  ```ts
  export interface NowPlayingProps {
    bot: BotMediaOverview;        // from @ts6/common, as SessionCard uses today
    now: number;                  // ms, from the page's 1 s clock
    variant: 'compact' | 'full';  // phase 2's console uses 'full'
    footer?: React.ReactNode;     // the hub passes its Open / Stop buttons here
  }
  export function NowPlaying(props: NowPlayingProps): JSX.Element;
  ```
  `compact` renders exactly what `SessionCard` renders today. `full` may be identical for now (phase 2 extends it); do not add features.
- Do **not** convert `BotPlayerCard` on Media Bots; phase 2 removes that tab.

- [ ] **Step 1:** Move `SessionCard`'s body into `NowPlaying` (compact). `SessionCard` becomes `<NowPlaying bot={bot} now={now} variant="compact" footer={…} />`.
- [ ] **Step 2:** `pnpm typecheck`, frontend unit tests (`bot-hub` helpers), Playwright `bot-hub.spec.ts` and `docs-screenshots.spec.ts`. Expected: PASS with no screenshot changes.
- [ ] **Step 3:** Commit, push, open the PR. Body: "No visible change. Prepares the console (1.10.0 phase 2)."

---

## Handoff notes

- **Merge #238 (NVENC) before Task 5.** Both edit `VideoStreamSettings` in `packages/common/src/types/music.ts` and `VideoStreamDefaultsCard.tsx`. #238 merges cleanly into `main` as of 2026-10-02 (sidecar `go vet` and `go test` pass on the merged tree). Task 5 must keep #238's encoder fields and labels when it adds `announceAutoStops`.
- Every task can start from `main` now; merge order does not matter, except that Task 3's UI path depends on whether Task 1 merged first (both locations are named above).
- Report back with the PR link; phase 2 starts after Task 1 and Task 6 merge.
