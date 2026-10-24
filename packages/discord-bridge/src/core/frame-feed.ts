import { Readable } from "node:stream";
import { MAX_QUEUED_FRAMES } from "./constants.js";

/**
 * Object-mode Opus packet source for an AudioPlayer. Everything not yet consumed, the private queue
 * plus the stream's own buffer, is bounded by one budget: when TeamSpeak delivers frames faster than
 * the 20 ms player tick the oldest frames are dropped, so latency cannot grow. The stream's buffer
 * is kept at one object (a Readable's default is 16) so it cannot hold stale audio on the side.
 */
export class FrameFeed extends Readable {
  private readonly queue: Buffer[] = [];
  private wanted = false;
  private finishing = false;
  dropped = 0;

  constructor(private readonly maxQueued = MAX_QUEUED_FRAMES) {
    super({ objectMode: true, highWaterMark: 1 });
  }

  offer(frame: Buffer): void {
    if (this.destroyed) return;
    this.queue.push(frame);
    this.drain();
    while (this.queued > this.maxQueued) {
      // Oldest first: that is the stream's buffered frame when it holds one, else the queue's head.
      if (this.readableLength > 0) this.read();
      else this.queue.shift();
      this.dropped += 1;
    }
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

  /** Frames held and not yet consumed: the private queue plus the stream's own buffer. */
  get queued(): number {
    return this.queue.length + this.readableLength;
  }
}
