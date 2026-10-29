import { processIdentityRequests, type DiscordUserInfo, type IdentityRequests, type IdentitySubscription } from "./identity-requests.js";

export type { DiscordUserInfo } from "./identity-requests.js";

/**
 * Identity only: has Discord told us this user is a human (not a bot account, and not one of the
 * bridge's own identities)?
 *
 * A positive answer is necessary for forwarding a user's audio and is never sufficient. Whether the
 * user is in the source voice channel right now, under the current receive generation, is decided
 * separately and on every frame by `VoiceAdmission`. So nothing here has to be withdrawn when a user
 * leaves: a late answer may teach the filter (and discord.js's user cache) that someone is human, and
 * that admits nobody who is not present.
 *
 * Fail closed: a user we know nothing about is not assumed to be human. They are looked up in the
 * background and stay excluded until the lookup says otherwise.
 *
 * The lookups are requests in the process-wide `IdentityRequests` registry, which owns their count:
 * at most `maxPending` unsettled per process and one per user, each held until its promise really
 * settles. This filter only decides when to ask and what to remember:
 * - A lookup over the registry's cap is refused, not queued: the speaker stays excluded and is asked
 *   about again when next seen (the receive supervisor asks while they speak).
 * - A lookup still unsettled after `lookupTimeoutMs` is counted as timed out and its user goes on a
 *   cooldown. The request it stands for keeps its registry slot until it settles, and if it answers
 *   late the answer is used. Asking about that user again while it is out joins the same request.
 * - A failed or timed out user is asked about again only after a cooldown that doubles with each
 *   consecutive failure, from `retryMs` up to `maxRetryMs`.
 * - Remembered answers and cooldowns are capped at `maxEntries` each, oldest first.
 * - `reset()` (a session ended) and `dispose()` drop what this filter knows and cancel its
 *   subscriptions to the requests it was waiting for, so a request that never settles does not keep
 *   a filter (or the bot that owns it) that was reset, disposed or replaced, and never calls it
 *   back. The requests themselves are untouched: still out, still counted until they settle, and
 *   another filter asking about the same user subscribes to them instead of starting another.
 *
 * Known limitation: the first moments of a speaker the client has never seen are not forwarded,
 * because they stay excluded while their identity is established (typically one REST round trip,
 * and up to the timeout and cooldown when Discord is slow). The bot-exclusion policy is not relaxed to
 * hide that. Someone who keeps speaking is picked up as soon as the answer arrives.
 */
export interface HumanFilterOptions {
  /** Synchronous read of what the Discord client already knows (`client.users.cache`). */
  cached: (userId: string) => DiscordUserInfo | undefined;
  /** Ask Discord. `null` means it could not be established. May reject, or never settle. Must be the request itself. */
  lookup: (userId: string) => Promise<DiscordUserInfo | null>;
  /** The bridge's own identities, including this bot. */
  excluded: (userId: string) => boolean;
  /** Where lookups are counted. Default: the process-wide registry. */
  requests?: IdentityRequests;
  now?: () => number;
  /** Cooldown after a failed lookup before the same user is asked about again; doubles per consecutive failure. */
  retryMs?: number;
  /** Upper bound of that cooldown. */
  maxRetryMs?: number;
  /** Cap on remembered identities and on remembered cooldowns, so a long session cannot grow without bound. */
  maxEntries?: number;
  /** How long a lookup may stay unsettled before the user is put on a cooldown. */
  lookupTimeoutMs?: number;
}

export interface HumanFilterStats {
  /** Identity requests out in the whole process, started and not yet settled (the registry's count). */
  pending: number;
  /** Of those, the ones unsettled past the registry's stall threshold. */
  stalled: number;
  /** Requests this filter is waiting on (each one is also in `pending`). */
  waiting: number;
  /** Subscriptions to unsettled requests over all callers in the process (the registry's count). */
  subscribers: number;
  /** Lookups this filter could not start because the process-wide cap was reached. */
  refused: number;
  timedOut: number;
  failed: number;
  remembered: number;
}

interface Wait {
  userId: string;
  /** The `reset()` round it belongs to: an answer from an earlier round is dropped. */
  round: number;
  timedOut: boolean;
  timer: NodeJS.Timeout | undefined;
  /** This filter's subscription to the request; cancelled when the wait is dropped. */
  subscription: IdentitySubscription | null;
}

export class HumanFilter {
  private readonly known = new Map<string, DiscordUserInfo>();
  private readonly cooldown = new Map<string, { until: number; failures: number }>();
  /** The request this filter is waiting on for each user, timed out or not: what stops it asking twice. */
  private readonly waiting = new Map<string, Wait>();
  private readonly requests: IdentityRequests;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly maxEntries: number;
  private readonly lookupTimeoutMs: number;
  private round = 0;
  private disposed = false;
  private refused = 0;
  private timedOut = 0;
  private failed = 0;

  constructor(private readonly o: HumanFilterOptions) {
    this.requests = o.requests ?? processIdentityRequests;
    this.now = o.now ?? Date.now;
    this.retryMs = o.retryMs ?? 5_000;
    this.maxRetryMs = Math.max(this.retryMs, o.maxRetryMs ?? 60_000);
    this.maxEntries = o.maxEntries ?? 1_024;
    this.lookupTimeoutMs = o.lookupTimeoutMs ?? 6_000;
  }

  /**
   * True only for a user known to be a human and not one of the bridge's own identities. Identity
   * only: it says nothing about whether the user may be heard (see `VoiceAdmission`).
   */
  isHuman(userId: string): boolean {
    if (this.o.excluded(userId)) return false;
    const info = this.o.cached(userId) ?? this.known.get(userId);
    if (info) return !info.bot;
    this.resolve(userId);
    return false;
  }

  private resolve(userId: string): void {
    if (this.disposed || this.waiting.has(userId)) return;
    const cooling = this.cooldown.get(userId);
    if (cooling && this.now() < cooling.until) return;
    const wait: Wait = { userId, round: this.round, timedOut: false, timer: undefined, subscription: null };
    wait.subscription = this.requests.request(userId, this.o.lookup, (info) => this.settled(wait, info));
    if (!wait.subscription) {
      this.refused += 1;
      return;
    }
    this.waiting.set(userId, wait);
    wait.timer = setTimeout(() => this.giveUp(wait), this.lookupTimeoutMs);
    wait.timer.unref();
  }

  /** The timeout: counted as a failure and the user goes on a cooldown. The wait stays until the request settles. */
  private giveUp(wait: Wait): void {
    wait.timer = undefined;
    if (this.waiting.get(wait.userId) !== wait) return;
    wait.timedOut = true;
    this.timedOut += 1;
    this.fail(wait.userId);
  }

  private settled(wait: Wait, info: DiscordUserInfo | null): void {
    clearTimeout(wait.timer);
    wait.timer = undefined;
    wait.subscription = null;
    if (this.waiting.get(wait.userId) === wait) this.waiting.delete(wait.userId);
    if (this.disposed || wait.round !== this.round) return; // from before a reset: this session never asked
    if (info) {
      this.cooldown.delete(wait.userId);
      this.remember(this.known, wait.userId, info);
    } else if (!wait.timedOut) this.fail(wait.userId); // a timed out lookup was already counted as a failure
  }

  private fail(userId: string): void {
    this.failed += 1;
    const failures = (this.cooldown.get(userId)?.failures ?? 0) + 1;
    const wait = Math.min(this.retryMs * 2 ** Math.min(failures - 1, 30), this.maxRetryMs);
    this.remember(this.cooldown, userId, { until: this.now() + wait, failures });
  }

  /**
   * The session ended: drop everything this filter knows and stop waiting. Its subscriptions are
   * cancelled, so no request still out refers to this filter or calls it back. The requests stay in
   * the registry, counted, until they settle; asking about one of those users again subscribes to it.
   */
  reset(): void {
    this.round += 1;
    for (const wait of this.waiting.values()) {
      clearTimeout(wait.timer);
      wait.timer = undefined;
      wait.subscription?.cancel();
      wait.subscription = null;
    }
    this.waiting.clear();
    this.known.clear();
    this.cooldown.clear();
  }

  /** Reset, and never ask anything again. */
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
    const r = this.requests.stats();
    return { pending: r.pending, stalled: r.stalled, waiting: this.waiting.size, subscribers: r.subscribers, refused: this.refused, timedOut: this.timedOut, failed: this.failed, remembered: this.size };
  }

  get size(): number {
    return this.known.size + this.cooldown.size;
  }
}
