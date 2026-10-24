import { MAX_QUEUED_FRAMES } from "./constants.js";
import { mixFrames } from "./pcm.js";

export interface QueuedFrame<M> {
  pcm: Buffer;
  meta: M;
  arrivedMs: number;
}

export interface MixResult<M> {
  pcm: Buffer;
  sources: string[];
  oldestArrivedMs: number;
  metas: M[];
  dropped: number;
}

/**
 * Per-source bounded queues mixed once per 20 ms tick. `admit` runs again at mix time, so a frame
 * queued under a stale generation is dropped even if it passed the check when it arrived.
 */
export class FrameMixer<M> {
  private readonly queues = new Map<string, QueuedFrame<M>[]>();
  droppedOverflow = 0;
  droppedAdmit = 0;

  constructor(
    private readonly admit: (meta: M) => boolean = () => true,
    private readonly maxQueued = MAX_QUEUED_FRAMES,
  ) {}

  push(source: string, pcm: Buffer, meta: M, arrivedMs: number): void {
    if (!this.admit(meta)) {
      this.droppedAdmit += 1;
      return;
    }
    let q = this.queues.get(source);
    if (!q) {
      q = [];
      this.queues.set(source, q);
    }
    q.push({ pcm, meta, arrivedMs });
    while (q.length > this.maxQueued) {
      q.shift();
      this.droppedOverflow += 1;
    }
  }

  /** Drop everything queued for sources matching the predicate (teardown). */
  flush(match: (source: string) => boolean = () => true): void {
    for (const key of this.queues.keys()) if (match(key)) this.queues.delete(key);
  }

  sourceCount(): number {
    return this.queues.size;
  }

  queuedFrames(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  /** Take one frame per source and mix. Returns null when no admitted frame is ready. */
  tick(): MixResult<M> | null {
    const frames: Buffer[] = [];
    const sources: string[] = [];
    const metas: M[] = [];
    let oldest = Number.POSITIVE_INFINITY;
    let dropped = 0;
    for (const [source, q] of this.queues) {
      let taken: QueuedFrame<M> | undefined;
      while (q.length > 0) {
        const f = q.shift()!;
        if (this.admit(f.meta)) {
          taken = f;
          break;
        }
        dropped += 1;
        this.droppedAdmit += 1;
      }
      if (q.length === 0 && !taken) this.queues.delete(source);
      if (taken) {
        frames.push(taken.pcm);
        sources.push(source);
        metas.push(taken.meta);
        oldest = Math.min(oldest, taken.arrivedMs);
      }
    }
    if (frames.length === 0) return null;
    return { pcm: mixFrames(frames), sources, oldestArrivedMs: oldest, metas, dropped };
  }
}
