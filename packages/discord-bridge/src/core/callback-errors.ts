import { safeError } from "./redact.js";

/** Where a network or timer callback can fail. A fixed set, so the per-site counts stay bounded. */
export type CallbackSite = "teamspeak voice" | "discord opus" | "tick: TeamSpeak to Discord overflow" | "tick: Discord to TeamSpeak mix";

/**
 * Counts callback failures per site and decides which to log: the first `first` at each site, then
 * one line each time that site's count reaches a power of two. A failure that repeats on every
 * 20 ms tick is counted in full but writes about log2(n) lines, not n. A line carries the error's
 * name and message only (`safeError`), never a stack.
 */
export class CallbackErrors {
  private readonly counts = new Map<CallbackSite, number>();
  total = 0;

  constructor(
    private readonly log: (line: string) => void,
    private readonly first = 5,
  ) {}

  note(site: CallbackSite, e: unknown): void {
    const n = (this.counts.get(site) ?? 0) + 1;
    this.counts.set(site, n);
    this.total += 1;
    if (n <= this.first || Number.isInteger(Math.log2(n))) {
      this.log(`${site} callback failed (${n} so far there, ${this.total} in all): ${safeError(e)}`);
    }
  }

  count(site: CallbackSite): number {
    return this.counts.get(site) ?? 0;
  }
}
