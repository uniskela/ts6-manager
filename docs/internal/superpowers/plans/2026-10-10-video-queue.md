# Video Queue and YouTube Playlist Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bot can stream queued videos and expanded YouTube playlists back to back, with Up next controls, a defined stop policy and a queue that survives restart.

**Architecture:** `PlayQueue` becomes generic and each bot gets a second instance, the video lane. A per-bot `VideoQueueController` owns that lane and advances by calling the existing `VoiceBot.setVideoSource()` on the running stream. `VoiceBot` gains one hook that lets the controller take over when a source finishes; the lane is persisted in one new Prisma table.

**Tech Stack:** TypeScript, Express, Prisma (SQLite), `node:test` run with `tsx --test`, React + TanStack Query, `@dnd-kit`, Playwright.

**Spec:** `docs/internal/superpowers/specs/2026-10-10-video-queue-design.md`

## Global Constraints

- Node.js 20, pnpm 9.15.9. Install with `pnpm install --frozen-lockfile`, then `pnpm db:generate`.
- Do not change anything under `packages/sidecar/`, `voice/listener-remote.ts`, `voice/commands/listener-remote.ts` or `routes/listener-remote.routes.ts`.
- Do not hand-edit `version.txt`, package versions, `app-version.ts` or `CHANGELOG.md`.
- Music behaviour is unchanged: no existing test in `voice/playlist/queue.test.ts`, `voice/music-command-handler.*.test.ts` or `routes/music-bots.*.test.ts` may be edited to pass.
- With an empty video lane, video start, stop and end behave exactly as before.
- Lane cap: 100 items. Playlist cap: 25 items per request. Consecutive failure cap: 3.
- A queued item stores the address the user gave, never a resolved media URL, and never `localHosts`, `volume` or `replaceSessionIds`.
- No new chat commands. `!stream` while streaming still switches the source.
- Commits use Conventional Commits and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. This machine has no git identity: pass `-c user.name="Uniskela" -c user.email="104075208+uniskela@users.noreply.github.com"` on each commit.
- Backend tests: `cd packages/backend && pnpm exec tsx --test <file>`. Frontend unit tests: `pnpm --filter @ts6/frontend test:unit`. Playwright: `pnpm --filter @ts6/frontend test -- <spec>`.

## Review Focus

Conditions the spec implies but does not spell out, most likely first. Each has a test in the task named.

1. **Stop lands while an advance is resolving the next video.** The swap throws "No active video stream"; that must not count as a source failure, must not skip further items and must not start anything. (Task 2)
2. **Skip pressed twice quickly.** The second press must act on the item that is current after the first finishes, not skip an item that never played. (Task 2)
3. **The same URL queued twice.** Both entries exist, have different ids, and removing one leaves the other. (Task 2)
4. **A playlist larger than the room left in the lane.** Items are truncated in order, the response says `truncated: true`, and a full lane answers 409 instead of silently dropping the request. (Task 5)
5. **The database write fails during a lane change.** Playback and the in-memory lane carry on; the error is logged, not thrown into the advance. (Task 4)

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/backend/src/voice/playlist/queue.ts` | Generic `PlayQueue<T>`, `rewind()` |
| `packages/common/src/types/music.ts` | `VideoQueueItemInfo`, `VideoQueueState`, `QueueVideoResponse` |
| `packages/backend/src/voice/streaming/video-queue.ts` | `VideoQueueController`: lane, transitions, stop policy |
| `packages/backend/src/voice/streaming/video-queue-store.ts` | Prisma-backed load/save of a bot's lane and session options |
| `packages/backend/src/voice/voice-bot.ts` | `videoSourceFinished` hook only |
| `packages/backend/src/voice/voice-bot-manager.ts` | One controller per bot, event wiring, disconnect stop |
| `packages/backend/src/routes/video-queue.routes.ts` | `/:id/stream/queue` routes |
| `packages/backend/src/routes/music-bots.routes.ts` | Mount the router; Stop clears the lane |
| `packages/backend/prisma/schema.prisma` + migration | `VideoQueueEntry` |
| `packages/frontend/src/api/…`, `hooks/use-music-bots.ts` | Queue API client and hooks |
| `packages/frontend/src/pages/bot-hub/link-request.ts`, `LinkSource.tsx` | Queue as video |
| `packages/frontend/src/pages/bot-hub/console-queue.ts`, `UpNextQueue.tsx`, `VideoUpNext.tsx` | Lane choice and the video lane list |

---

# PR 1 — Backend

Branch: `feat/253-video-queue-backend` from the current branch.

### Task 1: Generic `PlayQueue` with `rewind()`

**Files:**
- Modify: `packages/backend/src/voice/playlist/queue.ts`
- Test: `packages/backend/src/voice/playlist/queue.test.ts`

**Interfaces:**
- Produces: `class PlayQueue<T extends { id: string } = QueueItem>` with every existing member typed on `T`, plus `rewind(): void`.

- [ ] **Step 1: Write the failing tests** (append to `queue.test.ts`)

```ts
it('rewind keeps items and makes the current one upcoming again', () => {
  const q = new PlayQueue<{ id: string }>();
  q.addMany([{ id: 'a' }, { id: 'b' }]);
  q.next();
  assert.equal(q.current?.id, 'a');
  q.rewind();
  assert.equal(q.current, null);
  assert.equal(q.index, -1);
  assert.deepEqual(q.upcoming().map((i) => i.id), ['a', 'b']);
});

it('accepts a non-music item type', () => {
  const q = new PlayQueue<{ id: string; source: string }>();
  q.add({ id: 'v1', source: 'https://example.test/a' });
  assert.equal(q.next()?.source, 'https://example.test/a');
});
```

- [ ] **Step 2: Run** `pnpm exec tsx --test src/voice/playlist/queue.test.ts`. Expected: FAIL, `rewind is not a function` / type error.
- [ ] **Step 3: Implement.** Add the type parameter, replace `QueueItem` with `T` inside the class, add `rewind()` setting `currentIndex = -1`.
- [ ] **Step 4: Run** the same file and `pnpm --filter @ts6/backend typecheck`. Expected: PASS, no type errors anywhere (the default argument keeps call sites valid).
- [ ] **Step 5: Commit** `refactor(voice): make PlayQueue generic and add rewind`.

### Task 2: `VideoQueueController`

**Files:**
- Modify: `packages/common/src/types/music.ts`
- Create: `packages/backend/src/voice/streaming/video-queue.ts`
- Test: `packages/backend/src/voice/streaming/video-queue.test.ts`

**Interfaces:**
- Consumes: `PlayQueue<T>`, `rewind()` (Task 1); `VideoStreamStartOptions`, `MediaStopInfo`, `MediaStopReason`, `VideoSourceModeRequest`; `safeSourceLabel` from `voice/media-session.ts`.
- Produces, in `@ts6/common`:

```ts
export interface VideoQueueItemInfo {
  id: string; source: string; title: string;
  durationSec?: number; sourceMode: VideoSourceModeRequest; addedBy?: string;
}
export interface VideoQueueState { current: VideoQueueItemInfo | null; upNext: VideoQueueItemInfo[]; kept: boolean; }
export interface QueueVideoResponse {
  success: true; queued: number; started: boolean;
  playlistTitle?: string; truncated?: boolean; state: VideoQueueState;
}
```

- Produces, in `video-queue.ts`:

```ts
export const VIDEO_QUEUE_MAX = 100;
export const VIDEO_QUEUE_FAILURE_LIMIT = 3;
export type VideoQueueItem = VideoQueueItemInfo;
export type VideoQueueSessionOptions =
  Pick<VideoStreamStartOptions, 'preset' | 'encoder' | 'framerate' | 'bitrate' | 'noViewerTimeoutSec'>;
export type NewVideoQueueItem = Omit<VideoQueueItem, 'id'>;

export interface VideoQueueBot {
  readonly videoStreaming: boolean;
  readonly videoStreamStatus: { source: string | null };
  setVideoSource(source: string, volume?: number, sourceMode?: VideoSourceModeRequest): Promise<void>;
  stopVideoStream(reason?: MediaStopReason, detail?: string | null): Promise<void>;
  sendChannelMessage(msg: string): void;
}
export interface VideoQueueStore {
  save(items: VideoQueueItem[], options: VideoQueueSessionOptions | null): Promise<void>;
}
export interface VideoQueueDeps {
  bot: VideoQueueBot;
  /** Starts a stream under the manager's single-session rules. */
  start(source: string, options: VideoStreamStartOptions): Promise<unknown>;
  store: VideoQueueStore;
  onChange?(state: VideoQueueState): void;
  newId?(): string;
}
export class VideoQueueFullError extends AppError {} // 409, reason 'video_queue_full'

export class VideoQueueController {
  constructor(deps: VideoQueueDeps, initial?: { items: VideoQueueItem[]; options: VideoQueueSessionOptions | null });
  snapshot(): VideoQueueState;
  roomLeft(): number;
  enqueue(items: NewVideoQueueItem[], options?: VideoStreamStartOptions): Promise<{ queued: number; started: boolean }>;
  playQueue(options?: VideoStreamStartOptions): Promise<void>;
  skip(): Promise<void>;
  playAt(upNextIndex: number): Promise<void>;
  remove(upNextIndex: number): Promise<boolean>;
  move(from: number, to: number): Promise<boolean>;
  clear(): Promise<void>;
  /** True when the controller advanced and the caller must not stop the stream. */
  onSourceFinished(reason: MediaStopReason, detail: string | null): Promise<boolean>;
  onStreamStopped(info: MediaStopInfo | null): Promise<void>;
}
```

Rules the signatures do not determine:

- Lane shape: `[current, ...upNext]` with `index === 0` while a queued stream runs; `index === -1` otherwise. Advancing removes the old current.
- `enqueue` with nothing streaming starts `items[0]`, stores `options` reduced to `VideoQueueSessionOptions`, and passes the caller's full `options` (including `replaceSessionIds`, `volume`) to `start` once. If `start` throws, the items just added are removed and the error is rethrown.
- `enqueue` with a stream running and no lane current first inserts the running source at the front as current (`title: safeSourceLabel(source) ?? source`, `sourceMode: 'auto'`).
- `enqueue` throws `VideoQueueFullError` when `roomLeft() === 0`; otherwise adds at most `roomLeft()` items.
- Advance = take the first upcoming item, `bot.setVideoSource(item.source, undefined, item.sourceMode)`. On a throw while `bot.videoStreaming` is still true: remove the item, send the channel message ``Skipped "<title>": could not play it.``, count one failure, try the next. On a throw while `bot.videoStreaming` is false: stop trying, rewind, return `false`, count nothing.
- At `VIDEO_QUEUE_FAILURE_LIMIT` consecutive failures: `bot.stopVideoStream('source_unreachable', 'Stopped after 3 videos in a row failed')`, remaining items kept and rewound. A successful advance resets the count.
- `onSourceFinished`: returns `false` when the lane has no current or nothing upcoming. `source_ended` advances. `source_unreachable` and `encoder_failure` count one failure for the current item, send the skip message, then advance. Any other reason returns `false`.
- `onStreamStopped`: `manual` clears the lane and the stored options; `source_ended` with nothing upcoming empties the lane; every other reason, and `null`, rewinds and keeps.
- `skip` with nothing upcoming calls `bot.stopVideoStream('manual', 'Skipped the last queued video')`.
- `remove`, `move`, `playAt` take upcoming-relative indexes and return `false`/reject out-of-range without touching the current item.
- Every public mutating method runs through one promise chain (`private tail: Promise<void>`), and calls `store.save` then `onChange` after it changes the lane. A rejected `store.save` is caught and logged with `console.error`.

- [ ] **Step 1: Write the failing tests.** In `video-queue.test.ts`, build a `fakeBot()` recording `setVideoSource`, `stopVideoStream` and `sendChannelMessage` calls with a settable `videoStreaming` and a `failNext(n)` switch, a `start` spy that sets `videoStreaming = true`, and an in-memory `store`. One `it` per line:

| Test name | Asserts |
|---|---|
| `enqueue with nothing streaming starts the first item` | `start` called once with item 1's source; `snapshot().current.source` is item 1; `upNext.length === 1`; `kept === false` |
| `enqueue while streaming appends without touching the stream` | no `start`, no `setVideoSource`; `upNext` grows |
| `enqueue adopts a running one-shot stream as current` | `current.source` equals the running source; new item is `upNext[0]` |
| `a failed start removes the items it added` | `start` rejects → `enqueue` rejects; `snapshot()` is empty |
| `clean end advances to the next item` | `onSourceFinished('source_ended', null)` resolves `true`; `setVideoSource` called with item 2; finished item gone |
| `clean end with nothing upcoming lets the stream stop` | resolves `false`; then `onStreamStopped({reason:'source_ended'})` leaves the lane empty |
| `a failing next item is skipped with a notice` | `failNext(1)`; resolves `true`; one channel message containing `Skipped`; current is item 3 |
| `three failures in a row stop the stream and keep the rest` | 5 items, `failNext(3)`; `stopVideoStream` called with `'source_unreachable'`; `upNext.length === 1`; `kept` true after `onStreamStopped` |
| `a success resets the failure count` | fail 2, succeed, fail 2 → no stop |
| `source_unreachable on the current item skips it` | resolves `true`; current is item 2; one notice |
| `other reasons are not handled` | `'no_viewers'` resolves `false`; no `setVideoSource` |
| `auto-stop keeps the lane and rewinds` | `onStreamStopped({reason:'no_viewers'})` → `current === null`, `upNext[0]` is the interrupted item, `kept === true` |
| `manual stop clears the lane` | `onStreamStopped({reason:'manual'})` → empty; `store.save` last called with `([], null)` |
| `replaced_by_music, sidecar_failure, server_disconnect and bot_stopped keep the lane` | loop over the four reasons |
| `playQueue starts the first upcoming item with stored options` | `start` receives the preset saved at first enqueue |
| `skip advances, and stops when nothing is upcoming` | second case: `stopVideoStream('manual', …)` |
| `two quick skips act in order` (Review Focus 2) | call `skip()` twice without awaiting, with `setVideoSource` resolving on a deferred; current ends as item 3, `setVideoSource` calls are item 2 then item 3 |
| `stop during an advance is not a failure` (Review Focus 1) | `setVideoSource` rejects after the test sets `videoStreaming = false`; resolves `false`; no channel message; no further `setVideoSource`; items other than the finished one kept |
| `the same url queued twice gives two entries` (Review Focus 3) | ids differ; `remove(0)` leaves one with the same source |
| `remove, move and playAt use upcoming indexes and never touch current` | including out-of-range → `false` |
| `clear drops upcoming and keeps current` | |
| `enqueue truncates to the room left and throws when full` | 99 held + 3 → `queued === 1`; then `VideoQueueFullError` |
| `initial items load rewound` | constructor `initial` → `kept === true`, `current === null` |
| `every change is saved and announced` | `store.save` and `onChange` call counts after enqueue/remove/move |

- [ ] **Step 2: Run** `pnpm exec tsx --test src/voice/streaming/video-queue.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Add the common types**, then build `@ts6/common` (`pnpm --filter @ts6/common build`).
- [ ] **Step 4: Implement `video-queue.ts`** to the interface and rules above.
- [ ] **Step 5: Run** the test file and backend typecheck. Expected: all PASS.
- [ ] **Step 6: Commit** `feat(video): add the video queue controller`.

### Task 3: `videoSourceFinished` hook in `VoiceBot`

**Files:**
- Modify: `packages/backend/src/voice/voice-bot.ts` (`VoiceBotConfig`, `scheduleVideoEndStop` ~617, `pollVideoHealth` ~1823)
- Test: `packages/backend/src/voice/voice-bot.video-lifecycle.test.ts`

**Interfaces:**
- Produces: `VoiceBotConfig.videoSourceFinished?: (reason: MediaStopReason, detail: string | null) => Promise<boolean>` and `private async handleVideoSourceFinished(reason, detail): Promise<void>`.

Rules: `handleVideoSourceFinished` returns at once when `!_videoStreaming || _videoStopping`; awaits the hook inside try/catch (a throwing hook is logged and treated as `false`); calls `stopVideoStream(reason, detail)` only when the hook is absent or resolved `false`. The end timer and the encoder-exit branch call it instead of `stopVideoStream`. After a handled finish the encoder-exit branch returns without touching `_videoHealth`.

- [ ] **Step 1: Write the failing tests**, following the harness already in this file:

| Test name | Asserts |
|---|---|
| `end timer asks the hook and does not stop when it advances` | hook resolves `true` → `videoStreaming` still true, no `videoStreamStopped` event, hook called with `('source_ended', 'Video reached its end')` |
| `end timer stops as before when the hook declines` | hook resolves `false` → `lastStop.reason === 'source_ended'` |
| `encoder exit asks the hook with the classified reason` | stats `encoder.state: 'exited'` with an HTTP 404 error → hook called with `'source_unreachable'` |
| `a throwing hook falls back to the normal stop` | stream stops with the original reason |
| `no hook behaves as before` | existing assertions unchanged |

- [ ] **Step 2: Run** the file. Expected: the four new tests FAIL.
- [ ] **Step 3: Implement** the config field, the method and the two call-site changes.
- [ ] **Step 4: Run** `pnpm exec tsx --test src/voice/voice-bot.video-lifecycle.test.ts src/voice/voice-bot.media-session.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(video): let a queue take over when a video source finishes`.

### Task 4: Persistence and manager wiring

**Files:**
- Modify: `packages/backend/prisma/schema.prisma`
- Create: `packages/backend/prisma/migrations/20261010000000_video_queue/migration.sql`
- Create: `packages/backend/src/voice/streaming/video-queue-store.ts`
- Modify: `packages/backend/src/voice/voice-bot-manager.ts`
- Test: `packages/backend/src/voice/streaming/video-queue-store.test.ts`, `packages/backend/src/voice/voice-bot-manager.video-queue.test.ts`

**Interfaces:**
- Consumes: `VideoQueueController`, `VideoQueueStore`, `VideoQueueItem`, `VideoQueueSessionOptions` (Task 2); `videoSourceFinished` (Task 3).
- Produces:

```ts
// video-queue-store.ts
export function videoQueueOptionsKey(botId: number): string; // `video_queue_options:${botId}`
export function createVideoQueueStore(prisma: PrismaClient, botId: number): VideoQueueStore & {
  load(): Promise<{ items: VideoQueueItem[]; options: VideoQueueSessionOptions | null }>;
  delete(): Promise<void>;
};
// voice-bot-manager.ts
getVideoQueue(botId: number): VideoQueueController | undefined;
```

Schema, exactly as in the spec:

```prisma
model VideoQueueEntry {
  id          String   @id
  musicBotId  Int
  position    Int
  source      String
  title       String
  durationSec Int?
  sourceMode  String   @default("auto")
  addedBy     String?
  createdAt   DateTime @default(now())

  @@index([musicBotId, position])
}
```

Rules:

- `save` runs one `$transaction`: `deleteMany({ where: { musicBotId } })`, `createMany` with `position` 0..n-1, then upsert or delete the options `AppSetting` row.
- `load` orders by `position`; an options row that is not valid JSON loads as `null`.
- The manager creates the store and controller for every bot in both places it creates a `VoiceBot` (startup load and `createBot`), passes `videoSourceFinished: (r, d) => controller.onSourceFinished(r, d)` in the bot config, and `start: (source, options) => this.startVideoStream(bot, source, options)`.
- `bot.on('videoStreamStopped', (info) => controller.onStreamStopped(info ?? null))`.
- `onChange` broadcasts `music:bot:videoQueueChanged` with `{ botId, state }`.
- In the manager's existing `bot.on('disconnected')` handler, before scheduling a reconnect: `if (bot.videoStreaming) await bot.stopVideoStream('server_disconnect', 'Disconnected from the TeamSpeak server')`, errors caught and logged.
- `removeBot` calls `store.delete()` and drops the controller.

- [ ] **Step 1: Write the failing store tests** against a hand-rolled fake `prisma` (`videoQueueEntry.{deleteMany,createMany,findMany}`, `appSetting.{upsert,deleteMany,findUnique}`, `$transaction` running its callback or array):

| Test name | Asserts |
|---|---|
| `save writes positions in order and replaces previous rows` | `createMany` data positions `[0,1,2]`; `deleteMany` scoped to the bot |
| `save with null options removes the options row` | |
| `load returns items by position and parsed options` | |
| `load tolerates a corrupt options row` | options `null`, items still returned |
| `stored rows never carry localHosts, volume or replaceSessionIds` | keys of the saved options are a subset of the five allowed |

- [ ] **Step 2: Write the failing manager tests**:

| Test name | Asserts |
|---|---|
| `a bot loads its saved lane as kept` | `getVideoQueue(id).snapshot().kept === true` |
| `videoStreamStopped reaches the controller` | emit with `reason: 'manual'` → lane empty |
| `disconnect stops a running stream with server_disconnect` | `stopVideoStream` spy called with that reason |
| `a failing save does not break an advance` (Review Focus 5) | store `save` rejects → `onSourceFinished('source_ended', null)` still resolves `true` |
| `removing a bot deletes its lane` | `store.delete` called |

- [ ] **Step 3: Run** both files. Expected: FAIL.
- [ ] **Step 4: Add the model and migration.** Write `migration.sql` with `CREATE TABLE "VideoQueueEntry"` and `CREATE INDEX "VideoQueueEntry_musicBotId_position_idx"` in the style of `20261003000000_bot_avatars`; run `pnpm db:generate`.
- [ ] **Step 5: Implement** the store and the manager wiring.
- [ ] **Step 6: Run** both test files, `src/voice/voice-bot.connection.test.ts`, and backend typecheck. Expected: PASS.
- [ ] **Step 7: Commit** `feat(video): persist the video queue and wire it to each bot`.

### Task 5: Queue routes

**Files:**
- Create: `packages/backend/src/routes/video-queue.routes.ts`
- Modify: `packages/backend/src/routes/music-bots.routes.ts` (export `assertVideoSource`; mount; nothing else)
- Modify: `packages/backend/src/routes/media-audit.ts` (add actions `media.video.queue_add`, `media.video.queue_change`, `media.video.skip`)
- Modify: `docs/internal/audit-route-inventory.md`
- Test: `packages/backend/src/routes/music-bots.stream-queue.test.ts`

**Interfaces:**
- Consumes: `manager.getVideoQueue(botId)` (Task 4); `VideoQueueFullError`, `VIDEO_QUEUE_MAX` (Task 2); `assertVideoSource`, `parseStreamStartOptions`, `runMediaAudited`, `isYouTubePlaylistUrl` (`voice/audio/playlist-import-plan.ts`), `expandYouTubeToWatchUrls(url, cap)`.
- Produces: `export const VIDEO_PLAYLIST_CAP = 25;` and `export function createVideoQueueRoutes(deps?: { expandYouTube?: typeof expandYouTubeToWatchUrls }): Router`, mounted so paths are:

| Route | Body | Response |
|---|---|---|
| `GET /:id/stream/queue` | | `VideoQueueState` |
| `POST /:id/stream/queue` | `StartVideoStreamRequest` | `QueueVideoResponse` |
| `POST /:id/stream/queue/play` | optional start options | `{ success, state }` |
| `POST /:id/stream/queue/skip` | | `{ success, state }` |
| `POST /:id/stream/queue/:index/play` | | `{ success, state }` |
| `DELETE /:id/stream/queue/:index` | | `{ success, state }` |
| `PUT /:id/stream/queue/move` | `{ from, to }` | `{ success, state }` |
| `DELETE /:id/stream/queue` | | `{ success, state }` |

Rules:

- 404 `Music bot not found` when the bot or its controller is missing.
- `POST /`: validate with `assertVideoSource` and `parseStreamStartOptions`. When `isYouTubePlaylistUrl(source)`: `cap = Math.min(VIDEO_PLAYLIST_CAP, controller.roomLeft())`; if `cap === 0` throw `VideoQueueFullError`; call the expander with `cap + 1` and set `truncated` when it returns more than `cap`; no urls → 422 `Could not resolve any videos from that playlist URL`. Otherwise one item. Item fields: `title: safeSourceLabel(source) ?? source`, `sourceMode: options.sourceMode ?? 'auto'`, `addedBy: req.user.username`.
- When the enqueue will start a stream (nothing streaming), call `manager.assertVideoCanStart(bot, replaceSessionIds)` before the audited action, as `stream/start` does, and pass `replaceSessionIds` to `runMediaAudited`.
- `:index`, `from`, `to` must be non-negative integers → otherwise 400 `Invalid queue index`. A `false` from the controller → 404 `No queued video at that position`.
- `POST /:id/stream/stop` is unchanged: the manual stop reason already clears the lane through `onStreamStopped`.

- [ ] **Step 1: Write the failing tests**, using the `buildApp` pattern from `music-bots.stream-refused.test.ts` with a real `VideoQueueController` over a fake bot and an injected `expandYouTube`:

| Test name | Asserts |
|---|---|
| `queues a video while one is streaming` | 200, `queued: 1`, `started: false`, `state.upNext.length === 1` |
| `starts the stream when nothing is playing` | `started: true`, `state.current.source` set |
| `expands a playlist in order` | expander returns 3 urls → `upNext`/`current` sources in the same order; `playlistTitle` returned |
| `caps a playlist at 25 and says so` | expander returns 26 → `queued: 25`, `truncated: true` |
| `a playlist is cut to the room left` (Review Focus 4) | lane holds 98 → `queued: 2`, `truncated: true`, order kept |
| `a full lane answers 409 video_queue_full` (Review Focus 4) | body `details.reason` |
| `an empty playlist answers 422` | |
| `rejects a path-like source` | `../x.mp4` → 400 `source_invalid` |
| `rejects an invalid preset` | 400 |
| `passes a media session conflict through` | `assertVideoCanStart` throws `MediaSessionConflictError` → 409, nothing queued |
| `remove, move, play-now and clear change upNext` | one request each, then `GET` |
| `bad and out-of-range indexes` | `abc` → 400; `99` → 404 |
| `skip advances` | `setVideoSource` called with the next source |
| `stream/stop clears the lane` | after stop + emitted `manual` stop, `GET` is empty |

- [ ] **Step 2: Run** `pnpm exec tsx --test src/routes/music-bots.stream-queue.test.ts`. Expected: FAIL (404s).
- [ ] **Step 3: Implement** the router, the export, the mount and the audit actions; add the eight routes to the audit inventory.
- [ ] **Step 4: Run** `pnpm exec tsx --test "src/routes/music-bots.*.test.ts"` and backend typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(video): queue videos and YouTube playlists on a running stream`.

### Task 6: Open PR 1

- [ ] **Step 1:** Run the full backend suite as CI does (`.github/workflows/pr-validation.yml`, the `tsx --test` step) plus `pnpm typecheck` and `pnpm lint`. Expected: green.
- [ ] **Step 2:** Push the branch and open a PR into `main` titled `feat(video): queue videos and YouTube playlists on a running stream`. Body: summary, the three design decisions with a link to the spec, the disconnect behaviour change, test evidence, `Refs #253 (Slice 3)`. No `Release-As`.

---

# PR 2 — Console and docs

Branch: `feat/253-video-queue-console`, stacked on PR 1.

### Task 7: API client, hooks and "Queue as video"

**Files:**
- Modify: the music-bots API module that defines `musicBotsApi.startStream` (find with `grep -rn "startStream" packages/frontend/src/api`), `packages/frontend/src/hooks/use-music-bots.ts`
- Modify: `packages/frontend/src/pages/bot-hub/link-request.ts`, `LinkSource.tsx`
- Test: `packages/frontend/tests/unit/link-request.test.ts`, `packages/frontend/tests/bot-console-link.spec.ts`

**Interfaces:**
- Consumes: the routes and `VideoQueueState` / `QueueVideoResponse` from PR 1.
- Produces:

```ts
// api
videoQueue(botId): Promise<VideoQueueState>
queueVideo(botId, body: StartVideoStreamRequest): Promise<QueueVideoResponse>
playVideoQueue(botId), skipVideo(botId), playQueuedVideo(botId, index),
removeQueuedVideo(botId, index), moveQueuedVideo(botId, from, to), clearVideoQueue(botId)
// hooks — all invalidate ['video-queue', botId] and ['bot-media']
useVideoQueue(botId: number | null)   // queryKey ['video-queue', botId], refetchInterval 2000
useQueueVideo(), usePlayVideoQueue(), useSkipVideo(), usePlayQueuedVideo(),
useRemoveQueuedVideo(), useMoveQueuedVideo(), useClearVideoQueue()
// link-request.ts
export type LinkStartRequest = … | { endpoint: 'stream/queue'; body: StartVideoStreamRequest };
export function buildLinkStartRequest(input, mode, options?, videoStreaming = false): LinkStartRequest;
export function queuedVideoToast(res: Pick<QueueVideoResponse, 'queued' | 'started' | 'playlistTitle' | 'truncated'>): string;
```

Rules: `buildLinkStartRequest` returns `stream/queue` when `mode === 'video'` and `videoStreaming`. In `LinkSource`, `videoStreaming` is `session?.kind === 'video'` for this bot; the button reads **Queue as video** then, and the existing `alreadyThisFile` "Already streaming" label no longer applies in that state. A playlist URL entered with nothing streaming also uses `stream/queue` (use `/[?&]list=/.test(url) && !/[?&]v=/.test(url)` on YouTube hosts). Toast copy from `queuedVideoToast`:

- 1 item, started → `Video stream started`
- 1 item, queued → `Added to Up next`
- playlist → `Queued 12 videos from <title>` (`Queued 12 videos` without a title), suffixed ` (first 25)` when `truncated`

- [ ] **Step 1: Write the failing unit tests** in `link-request.test.ts`: the four `buildLinkStartRequest` cases (music; video idle; video while streaming → `stream/queue`; bare playlist idle → `stream/queue`) and the four toast strings above, exact.
- [ ] **Step 2: Write the failing Playwright test** in `bot-console-link.spec.ts`, mocking as the file already does: with a video session active, the button is named `Queue as video`, clicking posts to `**/stream/queue` with the typed source, and the toast `Added to Up next` appears.
- [ ] **Step 3: Run** `pnpm --filter @ts6/frontend test:unit` and the spec. Expected: FAIL.
- [ ] **Step 4: Implement** the API functions, hooks, request builder and `LinkSource` changes.
- [ ] **Step 5: Run** both again plus `pnpm --filter @ts6/frontend typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(console): queue a video from the Link tab`.

### Task 8: Video lane in Up next

**Files:**
- Modify: `packages/frontend/src/pages/bot-hub/console-queue.ts`, `UpNextQueue.tsx`, `BotConsole.tsx`
- Create: `packages/frontend/src/pages/bot-hub/VideoUpNext.tsx`
- Modify: the live-events handler that reacts to `music:bot:videoStreamStopped` (find with `grep -rn "videoStreamStopped" packages/frontend/src`) to invalidate `['video-queue', botId]` on `music:bot:videoQueueChanged`
- Test: `packages/frontend/tests/unit/console-queue.test.ts`, `packages/frontend/tests/bot-console.spec.ts`

**Interfaces:**
- Consumes: hooks from Task 7.
- Produces:

```ts
// console-queue.ts
export type UpNextLane = 'music' | 'video';
export function activeLane(input: {
  sessionKind: 'music' | 'video' | null; musicLive: boolean;
  musicUpNext: number; videoUpNext: number;
}): UpNextLane;
// VideoUpNext.tsx
export function VideoUpNext(props: { botId: number; state: VideoQueueState | undefined; streaming: boolean; loadError: unknown }): JSX.Element | null;
```

Rules:

- `activeLane` is `'video'` when `sessionKind === 'video'`, or when `sessionKind === null` and `videoUpNext > 0` and `musicUpNext === 0`; otherwise `'music'`.
- `BotConsole` renders `VideoUpNext` for the video lane and the existing `UpNextQueue` (unchanged props) for music. When the inactive lane has items, render it below as its one-line kept strip only.
- `VideoUpNext` reuses `rowKeys`, `moveUpNext`, the `Row` markup (extract `Row` from `UpNextQueue.tsx` into an exported component in the same file; `artist` line shows the item's host or `Live`) and the optimistic-move pattern. Indexes sent to the API are the list positions as shown.
- Header: `Up next (n)`, **Skip** (enabled while `streaming`), **Clear** (disabled at 0). No Shuffle, no Repeat.
- Kept strip when `state.kept`: `Up next (n) is kept. Nothing is streaming.` with **Play queue**.
- Empty and streaming: `No more videos queued. Add one from the Link tab.` Empty and idle: render nothing.
- Every icon button keeps a 40px target and an `aria-label` in the existing wording (`Remove <title> from the queue`, `Play <title> now`, `Drag to reorder <title>`).

- [ ] **Step 1: Write the failing unit tests** for `activeLane`: video session → video; idle with only video items → video; idle with both → music; music session with video kept → music; radio (`musicLive`) with video kept → music.
- [ ] **Step 2: Write the failing Playwright tests** in `bot-console.spec.ts`:

| Test name | Asserts |
|---|---|
| `shows queued videos while a video streams` | list `Up next` has the mocked titles in order; no `Shuffle` or `Repeat` button |
| `Skip, remove and play-now call the queue routes` | requests to `/stream/queue/skip`, `DELETE /stream/queue/1`, `POST /stream/queue/0/play` |
| `keyboard reorder sends upcoming indexes` | Space, ArrowDown, Space on the first handle → `PUT /stream/queue/move` body `{ from: 0, to: 1 }` |
| `a kept video queue offers Play queue` | idle bot, `kept: true` → strip text and `POST /stream/queue/play` on click |
| `music Up next is unchanged with an empty video lane` | existing music assertions still pass with the new endpoint mocked empty |

- [ ] **Step 3: Run** unit tests and the spec. Expected: FAIL.
- [ ] **Step 4: Implement** `activeLane`, `VideoUpNext`, the `Row` export, the `BotConsole` switch and the event invalidation.
- [ ] **Step 5: Run** `pnpm --filter @ts6/frontend test:unit`, `pnpm --filter @ts6/frontend test -- bot-console.spec.ts bot-console-link.spec.ts bot-console-music.spec.ts`, typecheck and lint. Expected: PASS.
- [ ] **Step 6: Commit** `feat(console): show and manage queued videos in Up next`.

### Task 9: Docs and PR 2

**Files:**
- Modify: `docs/public/video-streaming.md`, `docs/public/roadmap.md`

- [ ] **Step 1:** Add a "Queue videos and playlists" section to `video-streaming.md` covering: Queue as video; playlist limits (25 per link, 100 in the queue); automatic advance and the short gap; live sources need Skip; what each kind of stop does to the queue; the queue surviving a restart and needing **Play queue**; the stream now stopping on a TeamSpeak disconnect. Update the Slice 3 line in `roadmap.md`. Do not touch `docs/manifest.json` (no new page).
- [ ] **Step 2:** Run `pnpm typecheck`, `pnpm lint`, and the repo hygiene script CI runs for docs if one is listed in `pr-validation.yml`. Expected: green.
- [ ] **Step 3:** Commit `docs: queueing videos and YouTube playlists`.
- [ ] **Step 4:** Push and open a PR titled `feat(console): video Up next and Queue as video`, base `feat/253-video-queue-backend`, body with screenshots of the Link tab and Up next, test evidence and `Refs #253 (Slice 3)`. Note in the body that it retargets to `main` once PR 1 merges.
- [ ] **Step 5:** Comment on #253 with a short Progress / Next / Resume note linking both PRs.
