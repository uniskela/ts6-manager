import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Provenance = "LIVE" | "LIVE-TS6+SYNTHETIC-SPEAKERS" | "NATIVE-DEPS" | "SIMULATED" | "NOT-RUN";

export interface Check {
  id: string;
  title: string;
  result: "PASS" | "FAIL" | "NOT-RUN";
  provenance: Provenance;
  notes: string;
}

export class Evidence {
  readonly checks: Check[] = [];
  readonly data: Record<string, unknown> = {};

  add(check: Check): void {
    this.checks.push(check);
    process.stdout.write(`${check.result.padEnd(7)} ${check.provenance.padEnd(30)} ${check.id}: ${check.title}\n`);
  }

  get failed(): boolean {
    return this.checks.some((c) => c.result === "FAIL");
  }

  write(name: string): string {
    const dir = join(process.cwd(), "evidence");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), node: process.version, checks: this.checks, data: this.data }, null, 2));
    return file;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn` every 20 ms on an absolute schedule so jitter does not accumulate. */
export function every20ms(fn: (tick: number) => void): () => void {
  const start = process.hrtime.bigint();
  let n = 0;
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    fn(n++);
    const due = Number(start) / 1e6 + n * 20;
    const wait = Math.max(0, due - Number(process.hrtime.bigint()) / 1e6);
    setTimeout(loop, wait);
  };
  setTimeout(loop, 20);
  return () => {
    stopped = true;
  };
}
