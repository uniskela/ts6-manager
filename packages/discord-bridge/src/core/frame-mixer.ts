import { FRAME_BYTES, MAX_QUEUED_FRAMES } from "./constants.js";
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
 *
 * Decoders hand over whatever one packet holds (10 ms, 20 ms, 40 ms, ...). `push` cuts that into whole
 * 20 ms frames and keeps the remainder until the next packet, so nothing is truncated and no gap is
 * padded in. A partial tail is zero-padded only by `endSource`, when the speaker has really ended.
 */
export class FrameMixer<M> {
  private readonly queues = new Map<string, QueuedFrame<M>[]>();
  /** Samples of an unfinished 20 ms frame, per source. */
  private readonly tails = new Map<string, { buf: Buffer; arrivedMs: number; meta: M }>();
  droppedOverflow = 0;
  droppedAdmit = 0;
  /** PCM that was not whole stereo samples. */
  droppedMalformed = 0;
  /** Partial frames that were zero-padded because their speaker ended. */
  paddedTails = 0;

  constructor(
    private readonly admit: (meta: M) => boolean = () => true,
    private readonly maxQueued = MAX_QUEUED_FRAMES,
  ) {}

  push(source: string, pcm: Buffer, meta: M, arrivedMs: number): void {
    if (!this.admit(meta)) {
      this.droppedAdmit += 1;
      return;
    }
    if (pcm.length === 0 || pcm.length % 4 !== 0) {
      this.droppedMalformed += 1;
      return;
    }
    const tail = this.tails.get(source);
    const data = tail ? Buffer.concat([tail.buf, pcm]) : pcm;
    const firstArrived = tail?.arrivedMs ?? arrivedMs;
    const whole = Math.floor(data.length / FRAME_BYTES);
    const rest = data.subarray(whole * FRAME_BYTES);
    if (rest.length > 0) this.tails.set(source, { buf: Buffer.from(rest), arrivedMs, meta });
    else this.tails.delete(source);
    if (whole === 0) return;
    let q = this.queues.get(source);
    if (!q) {
      q = [];
      this.queues.set(source, q);
    }
    for (let i = 0; i < whole; i++) q.push({ pcm: data.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES), meta, arrivedMs: i === 0 ? firstArrived : arrivedMs });
    // Bound latency by dropping the oldest, but never frames of the packet that was just pushed.
    const limit = Math.max(this.maxQueued, whole);
    while (q.length > limit) {
      q.shift();
      this.droppedOverflow += 1;
    }
  }

  /** The speaker ended: pad its partial tail to a whole frame (counted) so the last samples are heard. */
  endSource(source: string): void {
    const tail = this.tails.get(source);
    if (!tail) return;
    this.tails.delete(source);
    if (!this.admit(tail.meta)) {
      this.droppedAdmit += 1;
      return;
    }
    const padded = Buffer.alloc(FRAME_BYTES);
    tail.buf.copy(padded);
    let q = this.queues.get(source);
    if (!q) {
      q = [];
      this.queues.set(source, q);
    }
    q.push({ pcm: padded, meta: tail.meta, arrivedMs: tail.arrivedMs });
    this.paddedTails += 1;
  }

  /** Drop everything queued for sources matching the predicate (teardown). */
  flush(match: (source: string) => boolean = () => true): void {
    for (const key of [...this.queues.keys()]) if (match(key)) this.queues.delete(key);
    for (const key of [...this.tails.keys()]) if (match(key)) this.tails.delete(key);
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
