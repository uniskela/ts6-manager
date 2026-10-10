# Video queue and YouTube playlist streaming

**Date:** 2026-10-10
**Status:** Design approved, spec awaiting review
**Scope:** #253 Slice 3 (formerly #291). Backend voice/streaming, music-bot routes, bot console. No change to the native sidecar or listener-remote authentication.

## Goal

Let a bot stream several videos in a row: queue a video while one is playing, expand a YouTube playlist into queued videos, advance automatically, and manage what is up next. A queued session must never leave the bot half-streaming, and the queue must still be there after a restart.

## Decisions

These were open in the roadmap and are now settled.

### 1. Queue model: two lanes, one class

Music and video do **not** share one list. `PlayQueue` becomes generic and each bot holds two instances: the existing music queue and a new video lane.

Why not one typed queue: a bot plays music or video, never both, and switching between them sets up or tears down a TeamSpeak stream. A mixed list would cross that boundary on any advance, and shuffle, repeat, `!queue`, vote-skip and the listener remote would all need kind-aware handling. That is a wide regression surface for music with no user-facing gain.

Why not a separate video queue class: `PlayQueue` already has tested add, remove-at, move and index bookkeeping. Reusing it is the "existing queue infrastructure" the roadmap asks for.

The video lane does not use shuffle or repeat in this slice.

### 2. Restart and reconnect: persist, resume manually

The video lane is stored in the database. After a backend restart or a TeamSpeak reconnect the items are back in Up next, no stream is running, and an admin presses **Play queue**. Nothing starts an encoder unattended. Automatic resumption belongs to Slice 4 (Auto-DJ / 24×7).

### 3. Stop policy: auto-stops keep, Stop clears

- No-viewer and channel-empty auto-stops end the stream and keep the lane, with the interrupted item back at the front.
- Manual Stop ends the stream and clears the lane, as music Stop clears the music queue.
- A source that fails is skipped. Three failures in a row stop the session and keep the remaining items.
- Live items never advance on their own.

## Approach

Advance by swapping the source on the running stream with the existing `VoiceBot.setVideoSource()`. The TeamSpeak stream, its viewers, the quality request, the encoder and the no-viewer timeout all belong to the stream and carry over; the visible gap is one FFmpeg restart.

A full stop and start per item was rejected. It drops every viewer between videos and re-enters the start-up races (`_videoStarting`, late `setupstream` confirmation) on every advance.

## Components

### `PlayQueue<T extends { id: string } = QueueItem>`

`voice/playlist/queue.ts`. Type parameter only, plus one method:

- `rewind()`: set `currentIndex` to `-1` without removing items. Used when a session is interrupted and the playing item becomes the first upcoming one again.

Every existing call site keeps compiling through the default type argument.

### `VideoQueueItem`

```ts
interface VideoQueueItem {
  id: string;                 // random, unique per entry
  source: string;             // original watch URL or music-folder filename
  title: string;              // display label; safeSourceLabel(source) until known
  durationSec?: number;
  sourceMode: VideoSourceModeRequest; // 'auto' unless the caller said live/vod
  addedBy?: string;           // admin username, for display
}
```

`source` is always the address the user gave, never a resolved media URL. Resolution happens inside the start/switch path (`downloadVideoForStream`) at play time, so an expiring YouTube URL is always fresh when it is used. Admin-approved IPTV `localHosts` are never stored on an item: a queued URL gets no LAN allowance.

### Lane shape

While a queued session is running, the lane is `[current, ...upNext]` with `currentIndex = 0`. A finished or skipped item is removed, so there is no history and no Previous. When no stream is running, `currentIndex = -1` and every item is upcoming. Bounds: at most 100 items in a lane.

### `VideoQueueController`

New file `voice/streaming/video-queue.ts`, one per bot, created by `VoiceBotManager`. It owns the lane, the session's start options and the failure counter. It depends on a narrow interface of the bot (`videoStreaming`, `startVideoStream` via the manager, `setVideoSource`, `stopVideoStream`, `sendChannelMessage`) and on a store interface, so it is tested with fakes.

Operations:

| Method | Behaviour |
|---|---|
| `enqueue(items, options)` | Append. If nothing is streaming, start the first item with `options` and remember them as the session options. If a stream is running with no lane current, adopt the running source as the current item first. |
| `playQueue(options?)` | Start the first upcoming item. Uses the stored session options unless new ones are given. |
| `skip()` | Advance now. With nothing upcoming, stop the stream (`manual`). |
| `playAt(index)` | Move that item to the front of upcoming, then advance. |
| `remove(index)`, `move(from, to)` | Upcoming items only; the current item is changed with Skip. |
| `clear()` | Drop upcoming items; the current item keeps playing. |
| `onSourceFinished(reason, detail)` | Called by the bot. Returns `true` when it advanced, `false` to let the normal stop run. |
| `onStreamStopped(info)` | Called on `videoStreamStopped`. Applies the stop policy. |
| `snapshot()` | State for the API. |

All mutating operations run through one promise chain per bot, so an advance, a skip and a remove cannot interleave.

### The seam in `VoiceBot`

Two places stop the stream when a source finishes on its own: `scheduleVideoEndStop` (duration timer) and `pollVideoHealth` (encoder exit). Both now call one private method, `handleVideoSourceFinished(reason, detail)`, which:

1. asks an optional `videoSourceFinished` hook supplied by the manager;
2. if the hook returns `true`, does nothing more;
3. otherwise calls `stopVideoStream(reason, detail)` exactly as before.

With no hook or an empty lane the behaviour is unchanged. No other part of `voice-bot.ts` changes.

### Persistence

One Prisma migration.

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

Session options (preset, encoder, framerate, bitrate, no-viewer timeout) are stored as one JSON `AppSetting` row per bot, `video_queue_options:<botId>`, cleared with the lane. `replaceSessionIds`, `volume` and `localHosts` are never stored.

The controller rewrites the bot's rows in one transaction after each lane change. Rows are deleted with the bot. On bot creation the manager loads the rows into the lane with `currentIndex = -1`.

## State transitions

| Event | Stream | Lane |
|---|---|---|
| Enqueue, nothing streaming | starts item 1 | `[cur, ...]` |
| Enqueue, stream running | unchanged | appended |
| Current ends cleanly (`source_ended`) | source swapped to next | finished item removed |
| Current ends, nothing upcoming | stops, `source_ended` | empty |
| Next item fails to resolve or the swap throws | channel notice; try the following item | failed item removed |
| Third consecutive failure | stops, `source_unreachable` | remaining items kept, rewound |
| Encoder exit on a VOD with an error | treated as a failure of the current item, as above | |
| Live item | never advanced by timer or clean exit; a live source that goes away counts as a failure | |
| Skip | swapped to next, or stopped if none | current removed |
| No-viewer or channel-empty auto-stop | stops | kept, rewound |
| Manual Stop (`manual`) | stops | cleared |
| Replaced by music or by another bot's stream | stops | kept, rewound |
| Sidecar failure, bot stopped, server disconnect | stops or is already gone | kept, rewound |
| Backend restart | none | loaded from the database, rewound |

A successful advance resets the failure counter. The no-viewer countdown belongs to the stream and is not reset by an advance, so a playlist nobody watches still stops after the configured timeout.

The bot's `disconnected` handler does not currently clear video state. The controller treats `disconnected` like a stop with reason `server_disconnect` for the lane (rewind), and the manager calls `stopVideoStream('server_disconnect')` so the sidecar source and timers are released before a reconnect.

## Playlist expansion

`POST /:id/stream/queue` accepts one source. When it is a bare YouTube playlist URL (`isYouTubePlaylistUrl`), the route calls the existing `expandYouTubeToWatchUrls(url, cap)` with `cap = min(25, room left in the lane)`:

- the result is ordered as the playlist is;
- all items are appended in one controller operation, so order is preserved against concurrent adds;
- a video URL that carries `&list=` stays a single video, as it does for music;
- an expansion that returns nothing answers 422 with the existing "Could not resolve any videos" wording.

Expansion is a single flat-playlist probe, so it runs inside the request; no per-item download happens until an item plays. Titles come from the probe where available.

## API

All under `/api/music-bots/:id/stream/queue`, authenticated and audited like `stream/start`.

| Route | Body | Result |
|---|---|---|
| `GET /` | | `VideoQueueState` |
| `POST /` | `StartVideoStreamRequest` | `{ queued, started, playlistTitle?, truncated?, state }` |
| `POST /play` | optional start options | starts the first upcoming item |
| `POST /skip` | | advances or stops |
| `POST /:index/play` | | plays that upcoming item now |
| `DELETE /:index` | | removes an upcoming item |
| `PUT /move` | `{ from, to }` | reorders upcoming items |
| `DELETE /` | | clears upcoming items |

Indexes are positions in the upcoming list. Sources go through `assertVideoSource`; options through `parseStreamStartOptions`. A full lane answers 409 with `reason: 'video_queue_full'`. Starting from the queue honours the same `replaceSessionIds` conflict flow as `stream/start`.

`VideoQueueState` (in `@ts6/common`):

```ts
interface VideoQueueState {
  current: VideoQueueItemInfo | null;
  upNext: VideoQueueItemInfo[];
  /** True when items are waiting and no queued stream is running. */
  kept: boolean;
}
```

`VideoQueueItemInfo` carries `id`, `title`, `durationSec`, `sourceMode` and `addedBy`. The raw `source` is included, as `videoStreamStatus.source` already is for the same audience. `POST /:id/stream/stop` keeps its route and now also clears the lane.

Queue changes broadcast `music:bot:videoQueueChanged` so open consoles refresh.

## UI

### Link tab

With **Stream as video** selected and a video already streaming on this bot, the primary button reads **Queue as video** and posts to the queue route. Otherwise it behaves as today. After a playlist the toast reads "Queued 12 videos from <title>", with "(first 25)" when truncated.

### Up next

`UpNextQueue` renders one lane:

- the video lane when a video session is active or the video lane is kept and no music is playing;
- the music lane otherwise, unchanged.

The video lane shows drag reorder, play now, remove and Clear, plus a **Skip** button, and no Shuffle or Repeat. When kept, it shows the existing dashed strip with **Play queue**. When both lanes hold items, the inactive one is shown as the one-line kept strip.

Row keys, the optimistic move and the index helpers in `console-queue.ts` are reused; the video lane's indexes are already upcoming-relative.

## Out of scope

- Native sidecar and listener-remote authentication.
- Chat commands: `!stream` while streaming still switches the source. No `!vqueue`.
- Video queueing from the listener remote.
- Shuffle, repeat and Previous for video.
- Auto-resume after restart (Slice 4).

## Tests

**Backend**

- `queue.test.ts`: `rewind()`; existing music cases run against the generic class.
- `video-queue.test.ts` with a fake bot and an in-memory store, one test per row of the transition table, plus: enqueue adopts a running one-shot stream; operations are serialised; the lane cap; `clear` keeps the current item; persistence is written after each change and restored rewound.
- `voice-bot.video-lifecycle.test.ts`: the end timer and encoder exit call the hook; `true` suppresses the stop, `false` and no hook stop as before.
- `music-bots.stream-queue.test.ts`: validation, playlist expansion order and cap, full lane, conflict passthrough, Stop clears.

**Frontend**

- `link-request.test.ts`: queue endpoint is chosen when a video is streaming.
- `UpNextQueue.test.tsx`: lane selection, no Shuffle or Repeat on video, Skip, remove and move call the queue routes with upcoming indexes, kept strip and Play queue.

## Delivery

Two PRs referencing #253 Slice 3.

1. `feat(video): queue videos and YouTube playlists on a running stream`. Backend: generic queue, controller, seam, migration, routes, common types, this spec.
2. `feat(console): video Up next and Queue as video`. Stacked on the first: Link tab, Up next, hooks, and `docs/public/video-streaming.md`.
