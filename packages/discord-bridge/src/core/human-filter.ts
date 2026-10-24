/**
 * Decides whether a Discord user may be subscribed to and forwarded into TeamSpeak.
 *
 * The contract is human-only audio, so the answer is fail closed: a user is admitted only when
 * Discord has told us they are not a bot. A user we know nothing about is not assumed to be human;
 * they are looked up in the background and stay excluded until the lookup says otherwise. A lookup
 * that fails (member metadata not available yet, REST error, timeout) leaves them excluded and is
 * retried only after a cooldown, so a speaker we cannot identify cannot cause a lookup storm.
 *
 * The bridge's own bots (and this bot itself) are never human, whatever Discord says.
 */
export interface DiscordUserInfo {
  bot: boolean;
}

export interface HumanFilterOptions {
  /** Synchronous read of what the Discord client already knows (`client.users.cache`). */
  cached: (userId: string) => DiscordUserInfo | undefined;
  /** Ask Discord. `null` means it could not be established. May reject. */
  lookup: (userId: string) => Promise<DiscordUserInfo | null>;
  /** The bridge's own identities, including this bot. */
  excluded: (userId: string) => boolean;
  now?: () => number;
  /** How long after a failed lookup before the same user is asked about again. */
  retryMs?: number;
  /** Cap on remembered identities and pending retries, so a long session cannot grow without bound. */
  maxEntries?: number;
}

export class HumanFilter {
  private readonly known = new Map<string, DiscordUserInfo>();
  private readonly retryAfter = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly maxEntries: number;

  constructor(private readonly o: HumanFilterOptions) {
    this.now = o.now ?? Date.now;
    this.retryMs = o.retryMs ?? 5_000;
    this.maxEntries = o.maxEntries ?? 1_024;
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
    if (this.inflight.has(userId)) return;
    const wait = this.retryAfter.get(userId);
    if (wait !== undefined && this.now() < wait) return;
    this.inflight.add(userId);
    const failed = () => this.remember(this.retryAfter, userId, this.now() + this.retryMs);
    this.o
      .lookup(userId)
      .then((info) => {
        if (info) {
          this.retryAfter.delete(userId);
          this.remember(this.known, userId, info);
        } else failed();
      }, failed)
      .finally(() => this.inflight.delete(userId));
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.maxEntries) map.delete(map.keys().next().value as string); // oldest first
  }

  get size(): number {
    return this.known.size + this.retryAfter.size;
  }
}
