export interface CommandRateLimit {
  take(key: string, nowMs: number): boolean;
}

export class MemoryCommandRateLimit implements CommandRateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  take(key: string, nowMs: number): boolean {
    const start = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > start);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }
}
