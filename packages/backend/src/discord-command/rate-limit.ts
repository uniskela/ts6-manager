export interface CommandRateLimit {
  take(key: string, nowMs: number): boolean;
}

/**
 * Sliding-window limiter with a hard cap on tracked keys so a long-lived
 * process cannot grow the map without bound. When at capacity, the oldest
 * idle key is dropped before admitting a new one.
 */
export class MemoryCommandRateLimit implements CommandRateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    /** Maximum distinct keys retained (guild:user or guild). */
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string, nowMs: number): boolean {
    const start = nowMs - this.windowMs;
    this.pruneStale(start);
    const recent = (this.hits.get(key) ?? []).filter((at) => at > start);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      this.evictOldestIdle(start);
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }

  /** Test helper: how many keys are currently tracked. */
  size(): number {
    return this.hits.size;
  }

  private pruneStale(start: number): void {
    for (const [k, times] of this.hits) {
      const recent = times.filter((at) => at > start);
      if (recent.length === 0) this.hits.delete(k);
      else if (recent.length !== times.length) this.hits.set(k, recent);
    }
  }

  private evictOldestIdle(start: number): void {
    let victim: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [k, times] of this.hits) {
      const last = times.length ? times[times.length - 1]! : 0;
      if (last <= start && last < oldest) {
        oldest = last;
        victim = k;
      }
    }
    if (victim) {
      this.hits.delete(victim);
      return;
    }
    // Every key is still in-window: drop the one with the oldest first hit.
    victim = null;
    oldest = Number.POSITIVE_INFINITY;
    for (const [k, times] of this.hits) {
      const first = times[0] ?? 0;
      if (first < oldest) {
        oldest = first;
        victim = k;
      }
    }
    if (victim) this.hits.delete(victim);
  }
}

/** Dual limiter: per guild:user fairness plus a coarser per-guild flood cap. */
export class FairCommandRateLimit implements CommandRateLimit {
  constructor(
    private readonly perUser: CommandRateLimit,
    private readonly perGuild: CommandRateLimit,
  ) {}

  take(key: string, nowMs: number): boolean {
    const colon = key.indexOf(':');
    const guildId = colon >= 0 ? key.slice(0, colon) : key;
    if (!this.perGuild.take(guildId, nowMs)) return false;
    return this.perUser.take(key, nowMs);
  }
}
