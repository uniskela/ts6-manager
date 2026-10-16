import type { ClientRateLimitInfo, Store } from 'express-rate-limit';

interface RateWindow {
  count: number;
  max: number;
  expiresAt: number;
}

/** The state of one key after a hit. `count > max` means the hit is refused. */
export interface RateHit {
  count: number;
  max: number;
  expiresAt: number;
}

/**
 * Fixed rate windows in a store with a hard size cap.
 *
 * Every window has the same length, so insertion order is expiry order. When
 * the store is full, a new key first frees expired windows, then takes the place
 * of a window still under its limit (fewest hits, oldest among equals). A window
 * that has reached its limit is never dropped early, so churning fresh keys
 * cannot reset it. If every window has reached its limit, only the new key is
 * refused, until the earliest window expires.
 */
export class RateWindows {
  private readonly windows = new Map<string, RateWindow>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.windows.size;
  }

  keys(): IterableIterator<string> {
    return this.windows.keys();
  }

  get(key: string): RateHit | undefined {
    const window = this.windows.get(key);
    return window && window.expiresAt > this.now() ? { ...window } : undefined;
  }

  prune(now = this.now()): void {
    for (const [key, window] of this.windows) {
      if (window.expiresAt > now) break;
      this.windows.delete(key);
    }
  }

  hit(key: string, max: number): RateHit {
    const now = this.now();
    let window = this.windows.get(key);
    if (window && window.expiresAt <= now) {
      this.windows.delete(key);
      window = undefined;
    }
    if (!window) {
      if (this.windows.size >= this.capacity) {
        this.prune(now);
        if (this.windows.size >= this.capacity && !this.evictOne()) {
          const earliest = this.windows.values().next().value!;
          return { count: max + 1, max, expiresAt: earliest.expiresAt };
        }
      }
      window = { count: 0, max, expiresAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count++;
    return { ...window };
  }

  decrement(key: string): void {
    const window = this.windows.get(key);
    if (window && --window.count <= 0) this.windows.delete(key);
  }

  delete(key: string): void {
    this.windows.delete(key);
  }

  clear(): void {
    this.windows.clear();
  }

  /** Drop the under-limit window with the fewest hits, oldest first. False when none is under its limit. */
  private evictOne(): boolean {
    let victim: string | undefined;
    let fewest = Infinity;
    for (const [key, window] of this.windows) {
      if (window.count >= window.max || window.count >= fewest) continue;
      victim = key;
      fewest = window.count;
      // Counts start at one, so the oldest one-hit window is the best possible choice.
      if (fewest <= 1) break;
    }
    if (victim === undefined) return false;
    this.windows.delete(victim);
    return true;
  }
}

/** An express-rate-limit store backed by `RateWindows`, so a limiter cannot grow without bound. */
export class BoundedRateLimitStore implements Store {
  readonly localKeys = true;
  private readonly windows: RateWindows;

  constructor(private readonly options: { windowMs: number; limit: number; capacity?: number; now?: () => number }) {
    this.windows = new RateWindows(options.capacity ?? 10_000, options.windowMs, options.now);
  }

  get size(): number {
    return this.windows.size;
  }

  get(key: string): ClientRateLimitInfo | undefined {
    const window = this.windows.get(key);
    return window && { totalHits: window.count, resetTime: new Date(window.expiresAt) };
  }

  increment(key: string): ClientRateLimitInfo {
    const window = this.windows.hit(key, this.options.limit);
    return { totalHits: window.count, resetTime: new Date(window.expiresAt) };
  }

  decrement(key: string): void {
    this.windows.decrement(key);
  }

  resetKey(key: string): void {
    this.windows.delete(key);
  }

  resetAll(): void {
    this.windows.clear();
  }
}
