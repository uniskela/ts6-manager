import type { Readable } from "node:stream";
import type { ReceiverElection } from "./receiver-election.js";
import type { BotId } from "./ids.js";
import type { Admission } from "./voice-admission.js";

export interface ReceiveSupervisorOptions {
  bot: BotId;
  generation: number;
  election: ReceiverElection;
  /** Opens an Opus packet stream for an admitted Discord user (receiver.subscribe). */
  subscribe: (userId: string) => Readable;
  /**
   * The user's admission to be heard now (`VoiceAdmission.admit`), or null. Nobody is subscribed
   * without one, and the stream is tied to the admission it was opened under.
   */
  admit: (userId: string) => Admission | null;
  /** Is that admission still valid (`VoiceAdmission.valid`). Checked for every packet. */
  admitted: (admission: Admission) => boolean;
  /**
   * Users whose packets are arriving right now. The supervisor re-reads this every sweep and opens
   * a stream for anyone speaking without one who is admitted, so reception never depends on a
   * speaking-start event (a human mid-sentence when the bot takes over, or whose stream died while
   * they kept talking, produces no new start).
   */
  activeSpeakers: () => Iterable<string>;
  onFrame: (userId: string, opus: Buffer, generation: number, admission: Admission) => void;
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

interface Subscription {
  stream: Readable;
  admission: Admission;
}

/**
 * Owns this bot's human subscriptions for one receiveGeneration. It subscribes only while the
 * election admits this bot and generation and the user holds a voice admission, tears every stream
 * down on `closeAll`, and tags every frame with the generation and admission it was opened under so
 * the mixer can fence late callbacks. A packet whose admission is no longer valid is dropped and its
 * stream closed. Once closed it ignores every callback from the streams it opened.
 */
export class ReceiveSupervisor {
  private readonly streams = new Map<string, Subscription>();
  private readonly errorTimes: number[] = [];
  private sweep: NodeJS.Timeout | null = null;
  private closed = false;
  decryptErrors = 0;
  /** Packets dropped because their admission had ended (the user left, or the admission was replaced). */
  admissionDropped = 0;

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
    const admission = this.o.admit(userId);
    if (!admission) return false;
    const stream = this.o.subscribe(userId);
    // The receiver hands back a stream it still holds; one destroyed but not yet released by its
    // `close` is of no use, and the next sweep gets a fresh one.
    if (stream.destroyed) return false;
    const sub: Subscription = { stream, admission };
    this.streams.set(userId, sub);
    this.o.election.noteSubscription(this.o.bot, 1);
    stream.on("data", (opus: Buffer) => {
      if (this.closed || this.streams.get(userId) !== sub) return; // stale callback from a replaced stream
      if (!this.o.admitted(admission)) {
        this.admissionDropped += 1;
        this.closeUser(userId); // the admission ended: nothing more from this stream
        return;
      }
      try {
        this.o.onFrame(userId, opus, this.o.generation, admission);
      } catch (e) {
        this.o.log?.(`frame handler failed for a user: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    stream.once("error", (e: Error) => this.handleError(e));
    // The library deletes its own subscription on `close`; releasing here, not on `error`, means a
    // user is re-opened only after the receiver can hand out a fresh stream.
    stream.once("close", () => this.release(userId, sub));
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

  private release(userId: string, sub: Subscription): void {
    if (this.streams.get(userId) === sub) {
      this.streams.delete(userId);
      this.o.election.noteSubscription(this.o.bot, -1);
      this.o.onUserClosed?.(userId);
    }
  }

  closeAll(): void {
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const [userId, sub] of this.streams) {
      this.release(userId, sub);
      sub.stream.destroy();
    }
  }

  /** Close one user's stream now (their admission ended). The next sweep re-opens them only if they are admitted again. */
  closeUser(userId: string): void {
    const sub = this.streams.get(userId);
    if (!sub) return;
    this.release(userId, sub);
    sub.stream.destroy();
  }

  /** The admission a user's open stream was opened under, for diagnostics and tests. */
  admissionOf(userId: string): Admission | undefined {
    return this.streams.get(userId)?.admission;
  }

  get openCount(): number {
    return this.streams.size;
  }
}
