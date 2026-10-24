import { Readable } from "node:stream";
import { MAX_QUEUED_FRAMES } from "./constants.js";

/**
 * Object-mode Opus packet source for an AudioPlayer. The queue is bounded: when TeamSpeak delivers
 * frames faster than the 20 ms player tick the oldest frames are dropped, so latency cannot grow.
 */
export class FrameFeed extends Readable {
  private readonly queue: Buffer[] = [];
  private wanted = false;
  private finishing = false;
  dropped = 0;

  constructor(private readonly maxQueued = MAX_QUEUED_FRAMES) {
    super({ objectMode: true });
  }

  offer(frame: Buffer): void {
    if (this.destroyed) return;
    this.queue.push(frame);
    while (this.queue.length > this.maxQueued) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.drain();
  }

  /** End the stream once the queued frames are consumed. */
  finish(): void {
    if (this.destroyed) return;
    this.finishing = true;
    this.drain();
  }

  override _read(): void {
    this.wanted = true;
    this.drain();
  }

  private drain(): void {
    while (this.wanted && this.queue.length > 0) {
      this.wanted = this.push(this.queue.shift());
    }
    if (this.finishing && this.queue.length === 0) {
      this.finishing = false;
      this.push(null);
    }
  }

  get queued(): number {
    return this.queue.length;
  }
}
