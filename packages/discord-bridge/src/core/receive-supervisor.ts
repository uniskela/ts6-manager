import type { Readable } from "node:stream";
import type { ReceiverElection } from "./receiver-election.js";
import type { BotId } from "./ids.js";

export interface ReceiveSupervisorOptions {
  bot: BotId;
  generation: number;
  election: ReceiverElection;
  /** Opens an Opus packet stream for a human Discord user (receiver.subscribe). */
  subscribe: (userId: string) => Readable;
  onFrame: (userId: string, opus: Buffer, generation: number) => void;
  /** Repeated decrypt failures: the voice connection should be rebuilt to re-run the DAVE handshake. */
  onNeedRejoin: (reason: string) => void;
  log?: (msg: string) => void;
  /** Consecutive stream errors inside the window before a rejoin is requested. */
  errorThreshold?: number;
  errorWindowMs?: number;
  now?: () => number;
}

/**
 * Owns this bot's human subscriptions for one receiveGeneration. It never subscribes to a user the
 * election has not admitted, tears every stream down on `closeAll`, and tags every frame with the
 * generation it was opened under so the mixer can fence late callbacks.
 */
export class ReceiveSupervisor {
  private readonly streams = new Map<string, Readable>();
  private readonly errorTimes: number[] = [];
  private closed = false;
  decryptErrors = 0;

  constructor(private readonly o: ReceiveSupervisorOptions) {}

  open(userId: string): boolean {
    if (this.closed || this.streams.has(userId)) return false;
    if (!this.o.election.admitSubscribe(this.o.bot, this.o.generation)) {
      this.closeAll();
      return false;
    }
    const stream = this.o.subscribe(userId);
    this.streams.set(userId, stream);
    this.o.election.noteSubscription(this.o.bot, 1);
    stream.on("data", (opus: Buffer) => this.o.onFrame(userId, opus, this.o.generation));
    stream.once("error", (e: Error) => this.handleError(userId, e));
    stream.once("close", () => this.release(userId, stream));
    return true;
  }

  private handleError(userId: string, e: Error): void {
    this.decryptErrors += 1;
    const now = (this.o.now ?? Date.now)();
    const window = this.o.errorWindowMs ?? 10_000;
    this.errorTimes.push(now);
    while (this.errorTimes.length && now - this.errorTimes[0] > window) this.errorTimes.shift();
    this.o.log?.(`receive stream error for a user: ${e.message}`);
    if (this.errorTimes.length >= (this.o.errorThreshold ?? 3)) {
      this.errorTimes.length = 0;
      this.o.onNeedRejoin("repeated decrypt failures");
    }
    // The stream is already destroyed by the library; the next speaking event re-opens it.
    this.release(userId, this.streams.get(userId));
  }

  private release(userId: string, stream: Readable | undefined): void {
    if (stream && this.streams.get(userId) === stream) {
      this.streams.delete(userId);
      this.o.election.noteSubscription(this.o.bot, -1);
    }
  }

  closeAll(): void {
    this.closed = true;
    for (const [userId, s] of this.streams) {
      this.release(userId, s);
      s.destroy();
    }
  }

  get openCount(): number {
    return this.streams.size;
  }
}
