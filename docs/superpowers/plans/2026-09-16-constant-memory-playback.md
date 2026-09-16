# Constant-Memory Music Playback Implementation Plan

> **Status:** Implemented and merged in fork PR #42. PR validation passed after the branch was reconciled with current `main`. The code/build/test work in this plan is complete; the long-running RSS and end-to-end playback checks below remain useful runtime smoke tests for operators/maintainers.
>
> **Goal:** Prevent long local/downloaded tracks from being decoded into a full in-memory PCM buffer before playback, while preserving pause, resume, seek, repeat, queue advancement, and reconnect reliability.

**Architecture:** Add an incremental FFmpeg file stream to `AudioPipeline`, pace finite-file decoding with `-re`, and let `VoiceBot` consume 20 ms PCM frames from the existing chunk queue. Pause applies stream backpressure; seek tears down the current FFmpeg process and starts a new one with input-side `-ss`. The reconnect state also tracks an active attempt so a disconnect emitted during `bot.start()` cannot schedule a parallel retry chain.

**Tech stack:** TypeScript, FFmpeg, Node streams, Node test runner.

---

### Task 1: Pin FFmpeg file-stream behaviour

**Files:**
- Create: `packages/backend/src/voice/audio/pipeline-file-stream.test.ts`
- Modify: `packages/backend/src/voice/audio/pipeline.ts`

1. Test that finite files use `-re` before the input so decode cannot race ahead of playback into RAM.
2. Test that seek uses input-side `-ss` and preserves real-time pacing.
3. Add `buildPcmFileArgs()` and `toPcmFileStream()`.

### Task 2: Replace whole-track PCM buffering

**Files:**
- Modify: `packages/backend/src/voice/voice-bot.ts`

1. Replace `pcmFrames`/`frameIndex` playback state with incremental file-stream state.
2. Start FFmpeg for local/downloaded files and append PCM chunks to the existing stream queue.
3. Pace exactly one 20 ms frame per playback slot.
4. Drain a final partial frame with zero-padding.
5. Preserve repeat-track and queue-next behaviour at EOF.
6. Pause by pausing stdout so FFmpeg is backpressured; resume the same process/tick.
7. Seek by killing the current FFmpeg process and starting a new one at the requested second.
8. Keep current direct YouTube/radio paths intact; if resuming a live/direct stream, reopen that stream rather than invoking the removed PCM-frame loop.

### Task 3: Close reconnect overlap race

**Files:**
- Create: `packages/backend/src/voice/reconnect-state.ts`
- Create: `packages/backend/src/voice/reconnect-state.test.ts`
- Modify: `packages/backend/src/voice/voice-bot-manager.ts`

1. Model reconnect state as timer-pending and/or attempt-in-flight.
2. Test idle, pending-timer, and active-attempt states.
3. Block scheduling when either state is busy.
4. Mark an attempt in flight before cleanup/start and clear it before intentionally scheduling the next backoff retry.

### Task 4: Verification

Completed during PR review / CI:

1. `pnpm --filter @ts6/common build`.
2. `pnpm --filter @ts6/backend typecheck`.
3. Focused file-stream and reconnect-state tests.
4. Workspace build and backend test suite in PR validation.

Runtime smoke checks that remain valuable after deployment:

1. Play a long local file and confirm playback begins without waiting for the whole track to decode.
2. Observe backend RSS during long playback and pause; memory should remain roughly flat rather than scaling with track duration.
3. Verify pause/resume, seek, repeat-track, queue-next, skip, stop, and on-demand downloaded-track playback.
4. Simulate a failed reconnect and confirm only one retry chain is scheduled.

**Historical environment note:** The original implementation session could not run repository-local commands in its sandbox, so the plan initially recorded verification as pending. Those build/typecheck/test checks were subsequently completed outside that sandbox before/through PR validation; do not use the old sandbox limitation as evidence that the merged change is untested.
