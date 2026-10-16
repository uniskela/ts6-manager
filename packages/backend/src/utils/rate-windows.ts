import { performance } from 'node:perf_hooks';
import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';

/** Monotonic milliseconds: a wall-clock step back cannot keep a stale window alive. */
export const monotonicNow = (): number => performance.now();

interface RateWindow {
  /** One count per limit, so related budgets for a key share one entry. */
  counts: number[];
  limits: readonly number[];
  expiresAt: number;
}

/** One counter of a key after a hit. `count > limit` means the hit is refused. */
export interface RateHit {
  count: number;
  limit: number;
  /** Milliseconds until the key's window resets. */
  remainingMs: number;
}

const exhausted = (window: RateWindow): boolean => window.counts.some((count, i) => count >= window.limits[i]);

/**
 * Fixed rate windows in a store with a hard size cap. Every window has the same
 * length and the clock is monotonic, so creation order is expiry order.
 *
 * Capacity never refuses a key. A new key on a full store first frees expired
 * windows, then replaces the oldest window still under all its limits. A window
 * that has reached a limit is dropped only when every window has, and then the
 * oldest goes first. Each step is O(1) amortised: under-limit windows are kept in
 * their own creation-ordered set.
 */
export class RateWindows {
  private readonly windows = new Map<string, RateWindow>();
  /** Keys of windows under all their limits, in creation order. */
  private readonly open = new Set<string>();
  /** Windows inspected while pruning or choosing a victim; tests use it to bound the work. */
  scanned = 0;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = monotonicNow,
  ) {}

  get size(): number {
    return this.windows.size;
  }

  keys(): IterableIterator<string> {
    return this.windows.keys();
  }

  /** Current counts of a live window, if any. */
  get(key: string): { counts: number[]; remainingMs: number } | undefined {
    const window = this.windows.get(key);
    const now = this.now();
    return window && window.expiresAt > now ? { counts: [...window.counts], remainingMs: window.expiresAt - now } : undefined;
  }

  prune(now = this.now()): void {
    for (const [key, window] of this.windows) {
      this.scanned++;
      if (window.expiresAt > now) break;
      this.delete(key);
    }
  }

  /** Count one hit on counter `index` of `key`, whose window has one limit per counter. */
  hit(key: string, limits: readonly number[], index = 0): RateHit {
    const now = this.now();
    let window = this.windows.get(key);
    if (window && window.expiresAt <= now) {
      this.delete(key);
      window = undefined;
    }
    if (!window) {
      if (this.windows.size >= this.capacity) this.makeRoom(now);
      window = { counts: limits.map(() => 0), limits, expiresAt: now + this.windowMs };
      this.windows.set(key, window);
      this.open.add(key);
    }
    window.counts[index]++;
    if (exhausted(window)) this.open.delete(key);
    return { count: window.counts[index], limit: window.limits[index], remainingMs: window.expiresAt - now };
  }

  decrement(key: string, index = 0): void {
    const window = this.windows.get(key);
    if (!window) return;
    window.counts[index] = Math.max(0, window.counts[index] - 1);
    if (window.counts.every(count => count === 0)) this.delete(key);
    else if (!exhausted(window)) this.open.add(key);
  }

  delete(key: string): void {
    this.windows.delete(key);
    this.open.delete(key);
  }

  clear(): void {
    this.windows.clear();
    this.open.clear();
  }

  private makeRoom(now: number): void {
    this.prune(now);
    if (this.windows.size < this.capacity) return;
    this.scanned++;
    // Under-limit windows go first; every remaining window has reached a limit,
    // so the oldest window is the oldest exhausted one.
    const victim: string = this.open.values().next().value ?? this.windows.keys().next().value!;
    this.delete(victim);
  }
}

/**
 * An express-rate-limit store backed by `RateWindows`, so a limiter cannot grow
 * without bound. `windowMs` and `limit` come from the limiter through `init`.
 */
export class BoundedRateLimitStore implements Store {
  readonly localKeys = true;
  private windows: RateWindows | undefined;
  private limits: readonly number[] = [];
  private window = 0;

  constructor(private readonly options: { capacity?: number; now?: () => number } = {}) {}

  init(options: Options): void {
    if (typeof options.limit !== 'number') throw new Error('BoundedRateLimitStore needs a numeric limit.');
    this.window = options.windowMs;
    this.limits = [options.limit];
    this.windows = new RateWindows(this.options.capacity ?? 10_000, options.windowMs, this.options.now);
  }

  get windowMs(): number {
    return this.window;
  }

  get limit(): number {
    return this.limits[0];
  }

  get size(): number {
    return this.store().size;
  }

  get(key: string): ClientRateLimitInfo | undefined {
    const window = this.store().get(key);
    return window && { totalHits: window.counts[0], resetTime: new Date(Date.now() + window.remainingMs) };
  }

  increment(key: string): ClientRateLimitInfo {
    const hit = this.store().hit(key, this.limits);
    return { totalHits: hit.count, resetTime: new Date(Date.now() + hit.remainingMs) };
  }

  decrement(key: string): void {
    this.store().decrement(key);
  }

  resetKey(key: string): void {
    this.store().delete(key);
  }

  resetAll(): void {
    this.store().clear();
  }

  private store(): RateWindows {
    if (!this.windows) throw new Error('BoundedRateLimitStore is used before init.');
    return this.windows;
  }
}
