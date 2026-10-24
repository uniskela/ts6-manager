import type { Readable } from "node:stream";
import type { ReceiverElection } from "./receiver-election.js";
import type { BotId } from "./ids.js";

export interface ReceiveSupervisorOptions {
  bot: BotId;
  generation: number;
  election: ReceiverElection;
  /** Opens an Opus packet stream for a human Discord user (receiver.subscribe). */
  subscribe: (userId: string) => Readable;
  /**
   * Humans whose packets are arriving right now. The supervisor re-reads this every sweep and opens
   * a stream for anyone speaking without one, so reception never depends on a speaking-start event
   * (a human mid-sentence when the bot takes over, or whose stream died while they kept talking,
   * produces no new start).
   */
  activeSpeakers: () => Iterable<string>;
  onFrame: (userId: string, opus: Buffer, generation: number) => void;
  /** A user's stream is gone (closed, errored or torn down): release per-user resources. */
  onUserClosed?: (userId: string) => void;
  /**
   * Repeated stream errors: reception failed closed and the DAVE session needs a genuine recovery.
   * Called at most once; the supervisor is closed by then.
   */
  onNeedRecovery: (reason: string) => void;
  log?: (msg: string) => void;
  /** Stream errors inside the window before reception fails closed. */
  errorThreshold?: number;
  errorWindowMs?: number;
  sweepMs?: number;
  now?: () => number;
}

/**
 * Owns this bot's human subscriptions for one receiveGeneration. It never subscribes to a user the
 * election has not admitted, tears every stream down on `closeAll`, and tags every frame with the
 * generation it was opened under so the mixer can fence late callbacks. Once closed it ignores
 * every callback from the streams it opened.
 */
export class ReceiveSupervisor {
  private readonly streams = new Map<string, Readable>();
  private readonly errorTimes: number[] = [];
  private sweep: NodeJS.Timeout | null = null;
  private closed = false;
  decryptErrors = 0;

  constructor(private readonly o: ReceiveSupervisorOptions) {}

  /** Start sweeping. The first reconcile runs now so people already speaking are picked up at once. */
  start(): void {
    if (this.closed || this.sweep) return;
    this.reconcile();
    this.sweep = setInterval(() => this.reconcile(), this.o.sweepMs ?? 40);
    this.sweep.unref();
  }

  /** Open a stream for every active speaker that has none. */
  reconcile(): void {
    if (this.closed) return;
    for (const userId of this.o.activeSpeakers()) {
      if (this.closed) return;
      this.open(userId);
    }
  }

  open(userId: string): boolean {
    if (this.closed || this.streams.has(userId)) return false;
    if (!this.o.election.admitSubscribe(this.o.bot, this.o.generation)) {
      this.closeAll();
      return false;
    }
    const stream = this.o.subscribe(userId);
    this.streams.set(userId, stream);
    this.o.election.noteSubscription(this.o.bot, 1);
    stream.on("data", (opus: Buffer) => {
      if (this.closed || this.streams.get(userId) !== stream) return; // stale callback from a replaced stream
      try {
        this.o.onFrame(userId, opus, this.o.generation);
      } catch (e) {
        this.o.log?.(`frame handler failed for a user: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    stream.once("error", (e: Error) => this.handleError(e));
    // The library deletes its own subscription on `close`; releasing here, not on `error`, means a
    // user is re-opened only after the receiver can hand out a fresh stream.
    stream.once("close", () => this.release(userId, stream));
    return true;
  }

  private handleError(e: Error): void {
    if (this.closed) return;
    this.decryptErrors += 1;
    const now = (this.o.now ?? Date.now)();
    const window = this.o.errorWindowMs ?? 10_000;
    this.errorTimes.push(now);
    while (this.errorTimes.length && now - this.errorTimes[0] > window) this.errorTimes.shift();
    this.o.log?.(`receive stream error for a user: ${e.message}`);
    if (this.errorTimes.length >= (this.o.errorThreshold ?? 3)) {
      this.errorTimes.length = 0;
      this.closeAll(); // fail closed: nothing is received until the caller has recovered the session
      this.o.onNeedRecovery("repeated decrypt failures");
    }
    // Below the threshold the stream closes on its own and the next sweep re-opens the user.
  }

  private release(userId: string, stream: Readable | undefined): void {
    if (stream && this.streams.get(userId) === stream) {
      this.streams.delete(userId);
      this.o.election.noteSubscription(this.o.bot, -1);
      this.o.onUserClosed?.(userId);
    }
  }

  closeAll(): void {
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const [userId, s] of this.streams) {
      this.release(userId, s);
      s.destroy();
    }
  }

  get openCount(): number {
    return this.streams.size;
  }
}
