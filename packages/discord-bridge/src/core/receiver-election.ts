import { EventEmitter } from "node:events";
import type { BotId } from "./ids.js";

export interface BotState {
  /** The bot's Discord voice connection is up and DAVE-ready. */
  healthy: boolean;
  /** The bot is allowed to be in the Discord channel (carries a uniqueId or is the idle receiver). */
  inChannel: boolean;
  /**
   * The bot's DAVE session is currently established. While false, no frame from this bot is admitted
   * and it is not elected. A transition can clear it briefly without the bot being unhealthy.
   */
  dave: boolean;
}

export interface ElectionStatus {
  receiver: BotId | null;
  generation: number;
  subscribersByBot: Record<string, number>;
  fenceDrops: number;
  subscribeRejections: number;
}

/**
 * Exactly one bot is the active Discord receiver. `generation` is monotonic and held by one bot.
 * Every human subscription and every decoded frame must pass `admit` (subscribe-time and
 * mix-time), so a callback that fires after teardown cannot reach the TeamSpeak mixer.
 */
export class ReceiverElection extends EventEmitter {
  private readonly states = new Map<BotId, BotState>();
  private holder: BotId | null = null;
  private gen = 0;
  private pinned: BotId | null = null;
  private readonly subs = new Map<BotId, number>();
  private fenceDrops = 0;
  private subscribeRejections = 0;

  constructor(private readonly order: readonly BotId[]) {
    super();
    for (const id of order) this.states.set(id, { healthy: false, inChannel: false, dave: true });
  }

  get generation(): number {
    return this.gen;
  }

  get receiver(): BotId | null {
    return this.holder;
  }

  pin(bot: BotId | null): void {
    this.pinned = bot;
  }

  setState(bot: BotId, patch: Partial<BotState>): void {
    const s = this.states.get(bot);
    if (!s) throw new Error(`unknown bot ${bot}`);
    Object.assign(s, patch);
  }

  private eligible(bot: BotId): boolean {
    const s = this.states.get(bot);
    return !!s && s.healthy && s.inChannel;
  }

  /** Can this bot be handed receive duty: eligible and DAVE established. */
  private electable(bot: BotId): boolean {
    return this.eligible(bot) && this.states.get(bot)!.dave;
  }

  /** The holder's reception is usable right now (DAVE established). */
  private receivingAllowed(bot: BotId): boolean {
    return this.holder === bot && this.states.get(bot)?.dave === true;
  }

  /** First healthy and eligible bot in preferred order, honouring an admin pin. */
  private pick(exclude?: BotId): BotId | null {
    const list = this.pinned ? [this.pinned, ...this.order.filter((b) => b !== this.pinned)] : [...this.order];
    for (const b of list) if (b !== exclude && this.electable(b)) return b;
    return null;
  }

  /**
   * Re-evaluate the receiver. The holder is sticky: it moves only when it is no longer eligible,
   * when overflow has joined the channel (overflow is preferred), or when an admin pin applies.
   * A move first bumps the generation and tears the old holder down so its subscriptions drop,
   * then elects the successor.
   */
  reconcile(reason: string): BotId | null {
    const best = this.pick();
    const holderOk = this.holder !== null && this.eligible(this.holder);
    if (holderOk && (best === this.holder || !this.mustMoveTo(best))) return this.holder;
    if (!holderOk && best === null && this.holder === null) return null;
    this.release(reason);
    if (best) {
      this.gen += 1;
      this.holder = best;
      this.subs.set(best, 0);
      this.emit("elected", { bot: best, generation: this.gen, reason });
    }
    return this.holder;
  }

  private mustMoveTo(best: BotId | null): boolean {
    return best !== null && (best === "overflow" || best === this.pinned);
  }

  /** The holder failed or was removed. Bumps generation, tears down, then elects the successor. */
  fail(bot: BotId, reason: string): BotId | null {
    this.setState(bot, { healthy: false });
    if (this.holder !== bot) return this.holder;
    return this.reconcile(`failure:${reason}`);
  }

  private release(reason: string): void {
    const old = this.holder;
    this.gen += 1; // strictly monotonic: the old generation is stale from here on
    this.holder = null;
    if (old) {
      this.subs.set(old, 0);
      this.emit("teardown", { bot: old, generation: this.gen, reason });
    }
  }

  /**
   * DAVE became unavailable for `bot` (an MLS transition, a downgrade, a decrypt-state reset).
   * Frames and sends from it stop immediately. If it is the receiver, the generation is bumped so
   * everything received before the loss is stale, reception is torn down, and the holder is kept
   * for the caller's grace window: `daveRestored` re-activates it, `fail` replaces it.
   */
  daveLost(bot: BotId, reason: string): void {
    const s = this.states.get(bot);
    if (!s) throw new Error(`unknown bot ${bot}`);
    if (!s.dave) return;
    s.dave = false;
    if (this.holder === bot) {
      this.gen += 1;
      this.subs.set(bot, 0);
      this.emit("teardown", { bot, generation: this.gen, reason: `dave lost:${reason}` });
    }
  }

  /** DAVE is established again. A holder resumes receiving under a fresh generation. */
  daveRestored(bot: BotId): void {
    const s = this.states.get(bot);
    if (!s) throw new Error(`unknown bot ${bot}`);
    if (s.dave) return;
    s.dave = true;
    if (this.holder === bot && this.eligible(bot)) {
      this.gen += 1;
      this.subs.set(bot, 0);
      this.emit("elected", { bot, generation: this.gen, reason: "dave restored" });
    }
  }

  /** Subscribe-time fence. A stale or non-holder bot is rejected and told to tear down. */
  admitSubscribe(bot: BotId, generation: number): boolean {
    const ok = this.receivingAllowed(bot) && generation === this.gen;
    if (!ok) {
      this.subscribeRejections += 1;
      this.emit("subscribeRejected", { bot, generation, current: this.gen });
    }
    return ok;
  }

  noteSubscription(bot: BotId, delta: 1 | -1): void {
    this.subs.set(bot, Math.max(0, (this.subs.get(bot) ?? 0) + delta));
  }

  /** Mix-time fence: called immediately before a decoded frame is mixed into TeamSpeak. */
  admitFrame(bot: BotId, generation: number): boolean {
    const ok = this.receivingAllowed(bot) && generation === this.gen;
    if (!ok) this.fenceDrops += 1;
    return ok;
  }

  /** Bots other than the holder that still hold human subscriptions. Must be empty. */
  duplicateReceivers(): BotId[] {
    return [...this.subs.entries()].filter(([b, n]) => n > 0 && b !== this.holder).map(([b]) => b);
  }

  status(): ElectionStatus {
    return {
      receiver: this.holder,
      generation: this.gen,
      subscribersByBot: Object.fromEntries(this.subs),
      fenceDrops: this.fenceDrops,
      subscribeRejections: this.subscribeRejections,
    };
  }
}
