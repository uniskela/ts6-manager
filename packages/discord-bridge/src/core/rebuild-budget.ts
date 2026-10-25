/**
 * The one budget for failure-driven reconnects of a Discord bot.
 *
 * Every automatic reason to build a connection again (the gateway destroyed it, the DAVE session
 * was poisoned, DAVE never came back, a join failed, the library refused a rejoin, a connection
 * could not be constructed) spends a token here, whichever code path asks. Planned joins (first
 * join, join after a deliberate leave, a rejoin the gateway accepts) are not charged. A token is
 * spent by the attempt that is about to rejoin or build a connection after a failure, one per
 * attempt, so an attempt that never reaches Ready still counts, and a successful join does not
 * refund it: the cost of a flapping connection is the number of attempts, not the number of failures.
 *
 * It is a sliding window. Tokens expire `windowMs` after they were spent, and that is the only way
 * the budget recovers. There is no manual reset and no reset on success, so no loop can spin a
 * bot's connection faster than `max` attempts per window.
 */
export class RebuildBudgetExhausted extends Error {
  readonly code = "REBUILD_BUDGET_EXHAUSTED";
  constructor(
    readonly retryInMs: number,
    max: number,
    windowMs: number,
  ) {
    super(`connection rebuild budget exhausted (${max} per ${windowMs} ms); next attempt allowed in ${retryInMs} ms`);
    this.name = "RebuildBudgetExhausted";
  }
}

export class RebuildBudget {
  private readonly spent: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** When the oldest token leaves the window (a full window if there is none to wait for). */
  private nextFreeInMs(): number {
    return this.spent.length === 0 ? this.windowMs : Math.max(1, this.spent[0] + this.windowMs - this.now());
  }

  private expire(): void {
    const t = this.now();
    while (this.spent.length > 0 && t - this.spent[0] >= this.windowMs) this.spent.shift();
  }

  /** Throw with when the next attempt is allowed if the budget is spent; spends nothing. */
  assertAvailable(): void {
    this.expire();
    if (this.spent.length >= this.max) {
      throw new RebuildBudgetExhausted(this.nextFreeInMs(), this.max, this.windowMs);
    }
  }

  /** Spend one token for an attempt that is about to start, or throw with when the next one is allowed. */
  spend(): void {
    this.assertAvailable();
    this.spent.push(this.now());
  }

  /** Milliseconds until an attempt would be allowed; 0 when one is allowed now. */
  retryInMs(): number {
    this.expire();
    return this.spent.length < this.max ? 0 : this.nextFreeInMs();
  }

  get used(): number {
    this.expire();
    return this.spent.length;
  }
}

export const isRebuildBudgetExhausted = (e: unknown): e is RebuildBudgetExhausted =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "REBUILD_BUDGET_EXHAUSTED";
