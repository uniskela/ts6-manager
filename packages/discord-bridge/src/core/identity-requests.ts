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
 *   subscribes to that same request, whoever started it, and starts nothing.
 *
 * Owning a request and waiting for its answer are separate. The registry owns the request (its slot,
 * its count, the promise). Each caller holds only a subscription, which it can cancel at any time:
 * cancelling drops the registry's reference to the caller's callback, so a filter or bot that was
 * reset, disposed or replaced is no longer reachable from a request that has not settled, and is
 * never called when it does. Cancelling a subscription never cancels or uncounts the request.
 * Nothing the registry keeps for an unsettled request refers to whoever started it: the `start`
 * function is called once and not kept.
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
  /** Subscriptions waiting on those requests, over all callers. */
  subscribers: number;
  /** Requests refused because `maxPending` were unsettled. */
  refused: number;
  /** Asks that joined a request already out for the same user instead of starting another. */
  shared: number;
  started: number;
  settled: number;
}

/** A caller's interest in one request's answer. */
export interface IdentitySubscription {
  /** Stop waiting: the callback is dropped and never called. The request itself carries on, counted. */
  cancel(): void;
}

type Settled = (info: DiscordUserInfo | null) => void;

interface Entry {
  startedAt: number;
  subscribers: Set<Settled>;
}

/**
 * Start a request. Kept out of `IdentityRequests.request` on purpose: closures created in one
 * function share its scope, so the settlement callback there would otherwise keep `start` (and
 * whatever `start` refers to, such as a bot) alive until the request settles. The returned promise
 * never rejects: a failed request, or a `start` that throws, resolves `null`.
 */
function begin(start: (userId: string) => Promise<DiscordUserInfo | null>, userId: string): Promise<DiscordUserInfo | null> {
  let answer: Promise<DiscordUserInfo | null>;
  try {
    answer = Promise.resolve(start(userId));
  } catch {
    return Promise.resolve(null);
  }
  return answer.then(
    (info) => (info && typeof info.bot === "boolean" ? { bot: info.bot } : null),
    () => null,
  );
}

/**
 * Add one subscription. Its own function for the same reason as `begin`: the registry's settlement
 * callback must not share a scope with `onSettled`, or cancelling would not release the subscriber.
 * A wrapper per subscription, so the same callback subscribed twice is two subscriptions.
 */
function subscribe(subscribers: Set<Settled>, onSettled: Settled): IdentitySubscription {
  const subscriber: Settled = (info) => onSettled(info);
  subscribers.add(subscriber);
  return { cancel: () => void subscribers.delete(subscriber) };
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
   * Wait for the answer about this user: subscribe to the request already out, or start one with
   * `start`. `null` when none is out and the cap is reached (nothing started, nothing subscribed).
   * `onSettled` is called once, asynchronously, when the request settles, unless the subscription
   * was cancelled first.
   */
  request(userId: string, start: (userId: string) => Promise<DiscordUserInfo | null>, onSettled: Settled): IdentitySubscription | null {
    const entry = this.entryFor(userId, start);
    return entry ? subscribe(entry.subscribers, onSettled) : null;
  }

  /** The unsettled request for this user, started now if none is out. `null` over the cap. */
  private entryFor(userId: string, start: (userId: string) => Promise<DiscordUserInfo | null>): Entry | null {
    const existing = this.out.get(userId);
    if (existing) {
      this.shared += 1;
      return existing;
    }
    if (this.out.size >= this.maxPending) {
      this.refused += 1;
      return null;
    }
    this.started += 1;
    const entry: Entry = { startedAt: this.now(), subscribers: new Set() };
    this.out.set(userId, entry);
    // This callback stays reachable until the request settles. It refers to the registry and the
    // entry only; `start` is not captured by any closure here.
    void begin(start, userId).then((info) => this.finish(userId, entry, info));
    return entry;
  }

  private finish(userId: string, entry: Entry, info: DiscordUserInfo | null): void {
    if (this.out.get(userId) === entry) this.out.delete(userId);
    this.settled += 1;
    const subscribers = [...entry.subscribers];
    entry.subscribers.clear();
    for (const notify of subscribers) {
      try {
        notify(info);
      } catch {
        /* one subscriber's failure must not keep the answer from the others */
      }
    }
  }

  /** Is a request for this user out right now. */
  has(userId: string): boolean {
    return this.out.has(userId);
  }

  stats(): IdentityRequestStats {
    const now = this.now();
    let stalled = 0;
    let subscribers = 0;
    for (const e of this.out.values()) {
      if (now - e.startedAt >= this.stallMs) stalled += 1;
      subscribers += e.subscribers.size;
    }
    return { pending: this.out.size, stalled, subscribers, refused: this.refused, shared: this.shared, started: this.started, settled: this.settled };
  }
}

/** The one registry of the process. Every bot uses it unless a test injects its own. */
export const processIdentityRequests = new IdentityRequests();
