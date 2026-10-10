/**
 * A bot's video lane: queued videos that play back to back on one stream.
 *
 * The lane is `[current, ...upNext]` while a queued stream runs and all
 * upcoming otherwise. Advancing swaps the source on the running stream, so
 * viewers, quality and the no-viewer countdown carry over.
 */

import { randomUUID } from 'crypto';
import type {
  MediaStopInfo,
  MediaStopReason,
  VideoQueueItemInfo,
  VideoQueueState,
  VideoSourceModeRequest,
} from '@ts6/common';
import { AppError } from '../../middleware/error-handler.js';
import { safeSourceLabel } from '../media-session.js';
import { PlayQueue } from '../playlist/queue.js';
import type { VideoStreamStartOptions } from '../voice-bot.js';

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

export class VideoQueueFullError extends AppError {
  constructor() {
    super(
      409,
      'The video queue is full',
      `It holds up to ${VIDEO_QUEUE_MAX} videos. Remove some, then try again.`,
      { reason: 'video_queue_full' },
    );
    this.name = 'VideoQueueFullError';
  }
}

const SESSION_OPTION_KEYS = ['preset', 'encoder', 'framerate', 'bitrate', 'noViewerTimeoutSec'] as const;

/** The part of a start request worth remembering; never volume, replace IDs or LAN hosts. */
export function toVideoQueueSessionOptions(options: VideoStreamStartOptions | undefined): VideoQueueSessionOptions | null {
  const kept: Record<string, unknown> = {};
  for (const key of SESSION_OPTION_KEYS) {
    if (options?.[key] !== undefined) kept[key] = options[key];
  }
  return Object.keys(kept).length > 0 ? (kept as VideoQueueSessionOptions) : null;
}

function noPosition(): AppError {
  return new AppError(404, 'No queued video at that position');
}

/** `advanced`: a queued video is playing. `stopped`: the stream went away. `gave_up`: stopped after repeated failures. `exhausted`: nothing playable is left. */
type AdvanceResult = 'advanced' | 'stopped' | 'gave_up' | 'exhausted';

export class VideoQueueController {
  private readonly lane = new PlayQueue<VideoQueueItem>();
  private options: VideoQueueSessionOptions | null = null;
  private failures = 0;
  /** True while an advance is replacing the source on the running stream. */
  private swapping = false;
  /** Every mutating operation is chained here so two never interleave. */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: VideoQueueDeps,
    initial?: { items: VideoQueueItem[]; options: VideoQueueSessionOptions | null },
  ) {
    if (initial) {
      this.lane.addMany(initial.items.slice(0, VIDEO_QUEUE_MAX));
      this.options = initial.options;
    }
  }

  snapshot(): VideoQueueState {
    const current = this.lane.current;
    const upNext = this.lane.upcoming();
    return {
      current: current ? { ...current } : null,
      upNext: upNext.map((item) => ({ ...item })),
      kept: current === null && upNext.length > 0,
    };
  }

  roomLeft(): number {
    return Math.max(VIDEO_QUEUE_MAX - this.lane.length, 0);
  }

  enqueue(items: NewVideoQueueItem[], options?: VideoStreamStartOptions): Promise<{ queued: number; started: boolean }> {
    return this.run(async () => {
      const streaming = this.deps.bot.videoStreaming;
      const adopted = streaming && this.lane.current === null ? this.deps.bot.videoStreamStatus.source : null;
      const room = this.roomLeft() - (adopted ? 1 : 0);
      if (room <= 0) throw new VideoQueueFullError();
      const added = items.slice(0, room).map((item) => ({ ...item, id: this.newId() }));
      if (added.length === 0) return { queued: 0, started: false };

      if (streaming) {
        if (adopted) {
          this.insertAtFront([{
            id: this.newId(),
            source: adopted,
            title: safeSourceLabel(adopted) ?? adopted,
            sourceMode: 'auto',
          }]);
          this.lane.playAt(0);
        }
        this.lane.addMany(added);
        await this.persist();
        return { queued: added.length, started: false };
      }

      // Nothing is streaming: the new videos play first, ahead of anything kept.
      const previousOptions = this.options;
      this.insertAtFront(added);
      this.lane.playAt(0);
      this.options = toVideoQueueSessionOptions(options) ?? previousOptions;
      this.failures = 0;
      try {
        await this.deps.start(added[0].source, { ...options, sourceMode: added[0].sourceMode });
      } catch (err) {
        for (let i = 0; i < added.length; i++) this.lane.removeAt(0);
        this.lane.rewind();
        this.options = previousOptions;
        throw err;
      }
      await this.persist();
      return { queued: added.length, started: true };
    });
  }

  playQueue(options?: VideoStreamStartOptions): Promise<void> {
    return this.run(async () => {
      this.assertNotStreaming();
      if (this.lane.length === 0) throw new AppError(409, 'The video queue is empty', 'Queue a video first.', { reason: 'video_queue_empty' });
      await this.startFirst(options);
    });
  }

  skip(): Promise<void> {
    return this.run(async () => {
      if (!this.deps.bot.videoStreaming) {
        throw new AppError(409, 'No active stream', 'Start a video first.', { reason: 'stream_not_running' });
      }
      if (this.lane.upcomingCount === 0) {
        await this.deps.bot.stopVideoStream('manual', 'Skipped the last queued video');
        return;
      }
      await this.advanceOrStop();
    });
  }

  /** `options` apply only when this starts a new stream (nothing is streaming). */
  playAt(upNextIndex: number, options?: VideoStreamStartOptions): Promise<void> {
    return this.run(async () => {
      const position = this.lanePosition(upNextIndex);
      if (position === null) throw noPosition();
      const first = this.lane.index + 1;
      this.lane.move(position, first);
      if (this.deps.bot.videoStreaming) {
        await this.advanceOrStop();
      } else {
        await this.startFirst(options);
      }
    });
  }

  remove(upNextIndex: number): Promise<boolean> {
    return this.run(async () => {
      const position = this.lanePosition(upNextIndex);
      if (position === null) return false;
      this.lane.removeAt(position);
      await this.persist();
      return true;
    });
  }

  move(from: number, to: number): Promise<boolean> {
    return this.run(async () => {
      const fromPosition = this.lanePosition(from);
      const toPosition = this.lanePosition(to);
      if (fromPosition === null || toPosition === null) return false;
      this.lane.move(fromPosition, toPosition);
      await this.persist();
      return true;
    });
  }

  clear(): Promise<void> {
    return this.run(async () => {
      while (this.lane.upcomingCount > 0) this.lane.removeAt(this.lane.length - 1);
      if (this.lane.length === 0) this.options = null;
      await this.persist();
    });
  }

  /** True when the controller advanced and the caller must not stop the stream. */
  onSourceFinished(reason: MediaStopReason, _detail: string | null): Promise<boolean> {
    // The report is about the video playing right now. By the time it reaches
    // the front of the chain a skip or an earlier report may have moved on.
    // While a swap is in flight the lane already points at the incoming video.
    const finishedId = this.swapping ? undefined : this.lane.current?.id ?? null;
    return this.run(async () => {
      const current = this.lane.current;
      if (finishedId === undefined || (finishedId !== null && current?.id !== finishedId)) {
        return current !== null && this.deps.bot.videoStreaming;
      }
      if (!current) return false;
      const failed = reason === 'source_unreachable' || reason === 'encoder_failure';
      if (this.lane.upcomingCount === 0) {
        if (!failed) return false;
        // The last video failed: drop it so a kept queue does not retry it,
        // and let the normal stop run with the bot's own reason.
        this.noteFailure(current);
        this.lane.removeAt(0);
        this.lane.rewind();
        await this.persist();
        return false;
      }
      if (failed) {
        this.noteFailure(current);
        if (this.failures >= VIDEO_QUEUE_FAILURE_LIMIT) {
          this.lane.removeAt(0);
          await this.giveUp();
          return true;
        }
      } else if (reason !== 'source_ended') {
        return false;
      }
      const result = await this.advance();
      await this.persist();
      return result === 'advanced' || result === 'gave_up';
    });
  }

  onStreamStopped(info: MediaStopInfo | null): Promise<void> {
    return this.run(async () => {
      const reason = info?.reason ?? null;
      this.failures = 0;
      if (reason === 'manual' || (reason === 'source_ended' && this.lane.upcomingCount === 0)) {
        this.lane.clear();
        this.options = null;
      } else {
        this.lane.rewind();
      }
      await this.persist();
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private newId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  /** Lane position of an upcoming index, or null when it is out of range. */
  private lanePosition(upNextIndex: number): number | null {
    if (!Number.isInteger(upNextIndex) || upNextIndex < 0 || upNextIndex >= this.lane.upcomingCount) return null;
    return this.lane.index + 1 + upNextIndex;
  }

  private insertAtFront(items: VideoQueueItem[]): void {
    const start = this.lane.length;
    this.lane.addMany(items);
    items.forEach((_, i) => this.lane.move(start + i, i));
  }

  private assertNotStreaming(): void {
    if (this.deps.bot.videoStreaming) {
      throw new AppError(409, 'A video is already streaming', 'Use Skip to move to the next queued video.', {
        reason: 'stream_already_running',
      });
    }
  }

  /** Start the first lane item on a new stream; the lane is left rewound if that fails. */
  private async startFirst(options?: VideoStreamStartOptions): Promise<void> {
    const item = this.lane.playAt(0);
    if (!item) return;
    // The session's remembered options, with anything the caller gave laid over them.
    const merged: VideoStreamStartOptions = { ...this.options, ...options };
    this.options = toVideoQueueSessionOptions(merged);
    this.failures = 0;
    try {
      await this.deps.start(item.source, { ...merged, sourceMode: item.sourceMode });
    } catch (err) {
      this.lane.rewind();
      await this.persist();
      throw err;
    }
    await this.persist();
  }

  private noteFailure(item: VideoQueueItem): void {
    this.failures++;
    this.deps.bot.sendChannelMessage(`Skipped "${item.title}": could not play it.`);
  }

  /** Stop after too many failures in a row; what is left stays queued. */
  private async giveUp(): Promise<void> {
    this.lane.rewind();
    await this.persist();
    try {
      await this.deps.bot.stopVideoStream(
        'source_unreachable',
        `Stopped after ${VIDEO_QUEUE_FAILURE_LIMIT} videos in a row failed`,
      );
    } catch (err) {
      console.error('[VideoQueue] Could not stop the stream after repeated failures:', err);
    }
  }

  /**
   * Drop the current item and swap the stream to the next one that plays.
   * The caller persists afterwards (giving up persists itself, before the stop).
   */
  private async advance(): Promise<AdvanceResult> {
    this.swapping = true;
    try {
      return await this.swapToNext();
    } finally {
      this.swapping = false;
    }
  }

  private async swapToNext(): Promise<AdvanceResult> {
    const { bot } = this.deps;
    if (this.lane.index === 0) this.lane.removeAt(0);
    while (this.lane.length > 0) {
      const item = this.lane.playAt(0)!;
      try {
        await bot.setVideoSource(item.source, undefined, item.sourceMode);
        this.failures = 0;
        return 'advanced';
      } catch (err) {
        if (!bot.videoStreaming) {
          // The stream was stopped while the next video was resolving.
          this.lane.rewind();
          return 'stopped';
        }
        console.warn(`[VideoQueue] Could not play a queued video (${safeSourceLabel(item.source) ?? 'unknown source'}):`, err instanceof Error ? err.message : err);
        this.lane.removeAt(0);
        this.noteFailure(item);
        if (this.failures >= VIDEO_QUEUE_FAILURE_LIMIT) {
          await this.giveUp();
          return 'gave_up';
        }
      }
    }
    this.lane.rewind();
    return 'exhausted';
  }

  /** A user-driven advance: with nothing left that plays, the stream stops. */
  private async advanceOrStop(): Promise<void> {
    const result = await this.advance();
    await this.persist();
    if (result === 'exhausted') {
      await this.deps.bot.stopVideoStream('manual', 'No queued video could be played');
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.store.save(this.lane.getAll().map((item) => ({ ...item })), this.options);
    } catch (err) {
      console.error('[VideoQueue] Could not save the video queue:', err);
    }
    this.deps.onChange?.(this.snapshot());
  }
}
