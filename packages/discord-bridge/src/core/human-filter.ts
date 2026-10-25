/**
 * Decides whether a Discord user may be subscribed to and forwarded into TeamSpeak.
 *
 * The contract is human-only audio, so the answer is fail closed: a user is admitted only when
 * Discord has told us they are not a bot. A user we know nothing about is not assumed to be human;
 * they are looked up in the background and stay excluded until the lookup says otherwise.
 *
 * Everything the filter holds is bounded, whatever the lookup function does:
 * - At most `maxPending` lookups are unsettled at once. A lookup over the limit is refused, not
 *   queued: the speaker stays excluded and is looked up when they are next asked about (the receive
 *   supervisor asks again while they speak). Nothing is remembered for a refused speaker.
 * - A lookup that is still unsettled after `lookupTimeoutMs` is given up on for that user (they go on
 *   a cooldown) but keeps its slot until the lookup really settles, so a lookup function that never
 *   settles can use up the slots but cannot make the filter hold more than `maxPending` of them.
 * - A failed or timed out user is asked about again only after a cooldown that doubles with each
 *   consecutive failure, from `retryMs` up to `maxRetryMs`.
 * - Remembered answers and cooldowns are capped at `maxEntries` each, oldest first.
 * - `forget(user)` and `reset()` cancel the lookups they cover: an answer that arrives later settles
 *   its slot and changes nothing else, so it cannot bring back a user who left or a session that ended.
 *
 * Known limitation: the first moments of a speaker the client has never seen are not forwarded,
 * because they stay excluded while their identity is established (typically one REST round trip,
 * and up to the timeout and cooldown when Discord is slow). The bot-exclusion policy is not relaxed to
 * hide that. Someone who keeps speaking is picked up as soon as the answer arrives.
 *
 * The bridge's own bots (and this bot itself) are never human, whatever Discord says.
 */
export interface DiscordUserInfo {
  bot: boolean;
}

export interface HumanFilterOptions {
  /** Synchronous read of what the Discord client already knows (`client.users.cache`). */
  cached: (userId: string) => DiscordUserInfo | undefined;
  /** Ask Discord. `null` means it could not be established. May reject, or never settle. */
  lookup: (userId: string) => Promise<DiscordUserInfo | null>;
  /** The bridge's own identities, including this bot. */
  excluded: (userId: string) => boolean;
  now?: () => number;
  /** Cooldown after a failed lookup before the same user is asked about again; doubles per consecutive failure. */
  retryMs?: number;
  /** Upper bound of that cooldown. */
  maxRetryMs?: number;
  /** Cap on remembered identities and on remembered cooldowns, so a long session cannot grow without bound. */
  maxEntries?: number;
  /** Cap on lookups that have started and not yet settled. */
  maxPending?: number;
  /** How long a lookup may stay unsettled before the user is put on a cooldown. */
  lookupTimeoutMs?: number;
}

export interface HumanFilterStats {
  /** Lookups started and not yet settled (including those already given up on). */
  pending: number;
  /** Of those, the ones past their timeout: abandoned by the filter, still unsettled underneath. */
  stalled: number;
  /** Lookups refused because `maxPending` were unsettled. */
  refused: number;
  timedOut: number;
  failed: number;
  remembered: number;
}

interface Lookup {
  userId: string;
  cancelled: boolean;
  timedOut: boolean;
  timer: NodeJS.Timeout | undefined;
}

export class HumanFilter {
  private readonly known = new Map<string, DiscordUserInfo>();
  private readonly cooldown = new Map<string, { until: number; failures: number }>();
  /** The lookup in its timeout window for each user: what stops a user being asked twice at once. */
  private readonly active = new Map<string, Lookup>();
  /** Every lookup that has started and not settled: what the cap counts. */
  private readonly unsettled = new Set<Lookup>();
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly maxEntries: number;
  private readonly maxPending: number;
  private readonly lookupTimeoutMs: number;
  private disposed = false;
  private refused = 0;
  private timedOut = 0;
  private failed = 0;

  constructor(private readonly o: HumanFilterOptions) {
    this.now = o.now ?? Date.now;
    this.retryMs = o.retryMs ?? 5_000;
    this.maxRetryMs = Math.max(this.retryMs, o.maxRetryMs ?? 60_000);
    this.maxEntries = o.maxEntries ?? 1_024;
    this.maxPending = o.maxPending ?? 8;
    this.lookupTimeoutMs = o.lookupTimeoutMs ?? 6_000;
  }

  /** True only for a user known to be a human and not one of the bridge's own identities. */
  isHuman(userId: string): boolean {
    if (this.o.excluded(userId)) return false;
    const info = this.o.cached(userId) ?? this.known.get(userId);
    if (info) return !info.bot;
    this.resolve(userId);
    return false;
  }

  private resolve(userId: string): void {
    if (this.disposed || this.active.has(userId)) return;
    const cooling = this.cooldown.get(userId);
    if (cooling && this.now() < cooling.until) return;
    if (this.unsettled.size >= this.maxPending) {
      this.refused += 1;
      return;
    }
    const lookup: Lookup = { userId, cancelled: false, timedOut: false, timer: undefined };
    this.unsettled.add(lookup);
    this.active.set(userId, lookup);
    lookup.timer = setTimeout(() => this.giveUp(lookup), this.lookupTimeoutMs);
    lookup.timer.unref();
    // The executor turns a lookup that throws synchronously into a rejection, like any other failed lookup.
    new Promise<DiscordUserInfo | null>((resolve) => resolve(this.o.lookup(userId))).then(
      (info) => this.settled(lookup, info),
      () => this.settled(lookup, null),
    );
  }

  /** The timeout of a lookup: the user waits out a cooldown; the lookup keeps its slot until it settles. */
  private giveUp(lookup: Lookup): void {
    lookup.timer = undefined;
    if (lookup.cancelled) return;
    lookup.timedOut = true;
    this.timedOut += 1;
    this.active.delete(lookup.userId);
    this.fail(lookup.userId);
  }

  private settled(lookup: Lookup, info: DiscordUserInfo | null): void {
    clearTimeout(lookup.timer);
    lookup.timer = undefined;
    this.unsettled.delete(lookup);
    if (lookup.cancelled) return; // the user left or the session ended while it was out: the answer is of no use
    if (this.active.get(lookup.userId) === lookup) this.active.delete(lookup.userId);
    if (info) {
      this.cooldown.delete(lookup.userId);
      this.remember(this.known, lookup.userId, info);
    } else if (!lookup.timedOut) this.fail(lookup.userId); // a timed out lookup was already counted as a failure
  }

  private fail(userId: string): void {
    this.failed += 1;
    const failures = (this.cooldown.get(userId)?.failures ?? 0) + 1;
    const wait = Math.min(this.retryMs * 2 ** Math.min(failures - 1, 30), this.maxRetryMs);
    this.remember(this.cooldown, userId, { until: this.now() + wait, failures });
  }

  private cancel(lookup: Lookup): void {
    lookup.cancelled = true;
    clearTimeout(lookup.timer);
    lookup.timer = undefined;
    this.active.delete(lookup.userId);
  }

  /** A user left: drop what is known, owed or in flight for them. An answer that arrives later is ignored. */
  forget(userId: string): void {
    this.known.delete(userId);
    this.cooldown.delete(userId);
    for (const lookup of this.unsettled) if (lookup.userId === userId) this.cancel(lookup);
  }

  /** The session ended: drop everything. Lookups still out keep their slots until they settle, and change nothing. */
  reset(): void {
    for (const lookup of this.unsettled) this.cancel(lookup);
    this.known.clear();
    this.cooldown.clear();
  }

  /** Reset, and never look anything up again. */
  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.maxEntries) map.delete(map.keys().next().value as string); // oldest first
  }

  stats(): HumanFilterStats {
    let stalled = 0;
    for (const lookup of this.unsettled) if (lookup.timedOut) stalled += 1;
    return { pending: this.unsettled.size, stalled, refused: this.refused, timedOut: this.timedOut, failed: this.failed, remembered: this.size };
  }

  get size(): number {
    return this.known.size + this.cooldown.size;
  }
}
