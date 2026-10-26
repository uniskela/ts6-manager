/**
 * The identity requests (Discord REST `GET /users/{id}`) that are out, for the whole process.
 *
 * A request is counted from the moment it starts until its promise really settles, and nothing
 * else ends it: not a timeout, a cooldown, a user leaving, a session reset or the bot or filter
 * that asked for it being disposed or replaced. discord.js gives no way to cancel a request that
 * has been handed to it (`Client.destroy()` clears REST sweepers and the token, and requests already
 * queued or on the wire carry on), so only settlement can free a slot.
 *
 * The registry outlives any one bot or identity filter. Every bot of a bridge process uses the one
 * default instance, so replacing a bot, or creating new bots after old ones were destroyed, cannot
 * add requests on top of the ones the old instances left behind:
 * - At most `maxPending` requests are unsettled at once in the process. A request over the cap is
 *   refused (the caller gets `null`), not queued.
 * - At most one request per user is unsettled. Asking about a user whose request is still out
 *   returns that same request, whoever started it, and starts nothing.
 *
 * An answer only says whether a Discord account is a bot. It never says the user may be heard: that
 * is the voice admission's decision (`voice-admission.ts`), made separately each time.
 */
export interface DiscordUserInfo {
  bot: boolean;
}

export interface IdentityRequestsOptions {
  /** Requests started and not yet settled, process wide. */
  maxPending?: number;
  /** A request unsettled for this long is reported as stalled (diagnostics only; it keeps its slot). */
  stallMs?: number;
  now?: () => number;
}

export interface IdentityRequestStats {
  /** Requests started and not yet settled. */
  pending: number;
  /** Of those, the ones unsettled for longer than `stallMs`. */
  stalled: number;
  /** Requests refused because `maxPending` were unsettled. */
  refused: number;
  /** Asks that joined a request already out for the same user instead of starting another. */
  shared: number;
  started: number;
  settled: number;
}

interface Entry {
  answer: Promise<DiscordUserInfo | null>;
  startedAt: number;
}

export class IdentityRequests {
  private readonly out = new Map<string, Entry>();
  private readonly maxPending: number;
  private readonly stallMs: number;
  private readonly now: () => number;
  private refused = 0;
  private shared = 0;
  private started = 0;
  private settled = 0;

  constructor(o: IdentityRequestsOptions = {}) {
    this.maxPending = o.maxPending ?? 8;
    this.stallMs = o.stallMs ?? 6_000;
    this.now = o.now ?? Date.now;
  }

  /**
   * The unsettled request for this user: the one already out, or a new one from `start`. `null` when
   * none is out and the cap is reached. The returned promise never rejects: a failed request, or a
   * `start` that throws, resolves `null`.
   */
  request(userId: string, start: (userId: string) => Promise<DiscordUserInfo | null>): Promise<DiscordUserInfo | null> | null {
    const existing = this.out.get(userId);
    if (existing) {
      this.shared += 1;
      return existing.answer;
    }
    if (this.out.size >= this.maxPending) {
      this.refused += 1;
      return null;
    }
    this.started += 1;
    // The executor turns a `start` that throws synchronously into a rejection, like any other failure.
    const answer = new Promise<DiscordUserInfo | null>((resolve) => resolve(start(userId))).then(
      (info) => (info && typeof info.bot === "boolean" ? { bot: info.bot } : null),
      () => null,
    );
    const entry: Entry = { answer, startedAt: this.now() };
    this.out.set(userId, entry);
    void answer.then(() => {
      if (this.out.get(userId) === entry) this.out.delete(userId);
      this.settled += 1;
    });
    return answer;
  }

  /** Is a request for this user out right now. */
  has(userId: string): boolean {
    return this.out.has(userId);
  }

  stats(): IdentityRequestStats {
    const now = this.now();
    let stalled = 0;
    for (const e of this.out.values()) if (now - e.startedAt >= this.stallMs) stalled += 1;
    return { pending: this.out.size, stalled, refused: this.refused, shared: this.shared, started: this.started, settled: this.settled };
  }
}

/** The one registry of the process. Every bot uses it unless a test injects its own. */
export const processIdentityRequests = new IdentityRequests();
