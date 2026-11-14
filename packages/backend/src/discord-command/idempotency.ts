import type { CommandResult, DiscordCommandIntent } from './adapter.js';

/** Retention for completed outcomes only. Pending claims do not expire by TTL. */
export const IDEMPOTENCY_RESULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 2_048;

type PendingEntry = { state: 'pending' };
type DoneEntry = { state: 'done'; expiresAt: number; result: CommandResult };
type Entry = PendingEntry | DoneEntry;

export type IdempotencyBegin =
  | { kind: 'execute' }
  | { kind: 'pending' }
  | { kind: 'replay'; result: CommandResult }
  | { kind: 'full' };

/**
 * Outcome-aware Discord command idempotency (interaction retries).
 *
 * Completed results are retained for {@link IDEMPOTENCY_RESULT_TTL_MS} (default 60s).
 * Active pending claims are never TTL-expired or capacity-evicted; when the cache is
 * full of pending work, new distinct keys are refused (`full`) rather than displacing
 * an in-flight operation.
 *
 * In-process only — cleared on restart and not shared across instances. This is not
 * permanent exactly-once delivery.
 */
export class MemoryCommandIdempotency {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = IDEMPOTENCY_RESULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  begin(key: string, nowMs: number): IdempotencyBegin {
    this.gcDone(nowMs);
    const current = this.entries.get(key);
    if (current?.state === 'pending') return { kind: 'pending' };
    if (current?.state === 'done' && nowMs <= current.expiresAt) {
      return { kind: 'replay', result: current.result };
    }
    // Drop stale done before inserting so capacity counts only live entries.
    if (current?.state === 'done') this.entries.delete(key);

    if (this.entries.size >= this.maxEntries) {
      this.evictOldestDone(this.entries.size - this.maxEntries + 1);
    }
    if (this.entries.size >= this.maxEntries) return { kind: 'full' };

    this.entries.set(key, { state: 'pending' });
    return { kind: 'execute' };
  }

  complete(key: string, result: CommandResult, nowMs: number): void {
    this.gcDone(nowMs);
    // Only settle our own pending slot — never overwrite an unrelated newer claim.
    const current = this.entries.get(key);
    if (current && current.state !== 'pending') return;

    this.entries.set(key, {
      state: 'done',
      expiresAt: nowMs + this.ttlMs,
      result: {
        ok: result.ok,
        code: result.code,
        ephemeral: result.ephemeral,
        content: result.content,
        ack: result.ack,
      },
    });
    if (this.entries.size > this.maxEntries) {
      this.evictOldestDone(this.entries.size - this.maxEntries);
    }
  }

  /** Test/observability helper — not part of the hot path. */
  peek(key: string, nowMs: number): Entry | undefined {
    this.gcDone(nowMs);
    return this.entries.get(key);
  }

  private gcDone(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.state === 'done' && nowMs > entry.expiresAt) this.entries.delete(key);
    }
  }

  /** Evict oldest completed records only — never pending. */
  private evictOldestDone(needed: number): void {
    if (needed <= 0) return;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.state !== 'done') continue;
      this.entries.delete(key);
      removed += 1;
      if (removed >= needed) return;
    }
  }
}

/**
 * Scope Discord interaction ids per guild/user/command/subcommand.
 * Payload/query is not part of the key: Discord retries reuse the same interaction id;
 * a different operation gets a different interaction id from Discord.
 */
export function musicIdempotencyKey(intent: DiscordCommandIntent): string | null {
  if (!intent.idempotencyKey) return null;
  const sub = intent.args?.subcommand ?? '';
  return `${intent.guildId}\0${intent.userId}\0${intent.command}\0${sub}\0${intent.idempotencyKey}`;
}
