export class LatencyStats {
  private readonly samples: number[] = [];

  record(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > 20_000) this.samples.shift();
  }

  summary(): { n: number; p50: number; p95: number; max: number } {
    if (this.samples.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
    const s = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
  }
}

/** Samples process CPU (percent of one core) and RSS over a window. */
export class ResourceSampler {
  private timer: NodeJS.Timeout | null = null;
  private lastCpu = process.cpuUsage();
  private lastAt = process.hrtime.bigint();
  readonly cpuPercent: number[] = [];
  readonly rssMb: number[] = [];

  start(intervalMs = 1000): void {
    this.lastCpu = process.cpuUsage();
    this.lastAt = process.hrtime.bigint();
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref();
  }

  sample(): void {
    const cpu = process.cpuUsage(this.lastCpu);
    const now = process.hrtime.bigint();
    const wallUs = Number(now - this.lastAt) / 1000;
    this.cpuPercent.push(((cpu.user + cpu.system) / wallUs) * 100);
    this.rssMb.push(process.memoryUsage().rss / 1024 / 1024);
    this.lastCpu = process.cpuUsage();
    this.lastAt = now;
  }

  stop(): { cpuAvgPercent: number; cpuMaxPercent: number; rssAvgMb: number; rssMaxMb: number; samples: number } {
    if (this.timer) clearInterval(this.timer);
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const max = (a: number[]) => (a.length ? Math.max(...a) : 0);
    const r = (n: number) => Math.round(n * 10) / 10;
    return {
      cpuAvgPercent: r(avg(this.cpuPercent)),
      cpuMaxPercent: r(max(this.cpuPercent)),
      rssAvgMb: r(avg(this.rssMb)),
      rssMaxMb: r(max(this.rssMb)),
      samples: this.cpuPercent.length,
    };
  }
}
