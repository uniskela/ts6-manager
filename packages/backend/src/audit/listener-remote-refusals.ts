/**
 * Listener remote refusals as bounded audit totals.
 *
 * Refused access, rate limits, permission denials and full queues are counted
 * per source and window and written as a few rows per window, never one row
 * per request, so unauthenticated traffic cannot fill or crowd out the audit
 * log:
 *
 * - each window keeps at most `sourcesPerWindow` sources per kind; further
 *   sources add to one overflow row, so totals are never lost;
 * - access refusals and rate limits (the kinds unauthenticated traffic can
 *   cause) are written when the window ends, in one batch;
 * - the first permission denial or full queue per listener and bot is written
 *   at once, and its total is updated when the window ends;
 * - refusal totals have two retention budgets of their own (unauthenticated
 *   and verified listeners) and never count toward the global cap (see retention.ts).
 *
 * Recording never changes a response: the request is refused either way, and a
 * failed write is logged and dropped. Routine validation refusals are only
 * counted and logged.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { AdminAuditAction, AdminAuditResultCode } from '@ts6/common';
import { buildRow } from './writer.js';

export type RefusalKind = 'auth_failed' | 'rate_limited' | 'denied' | 'capacity';

const ACTIONS: Readonly<Record<RefusalKind, AdminAuditAction>> = {
  auth_failed: 'listener.remote.auth_failed',
  rate_limited: 'listener.remote.rate_limited',
  denied: 'listener.remote.denied',
  capacity: 'listener.remote.capacity',
};

const RESULTS: Readonly<Record<RefusalKind, AdminAuditResultCode>> = {
  auth_failed: 'invalid_access',
  rate_limited: 'rate_limited',
  denied: 'permission_denied',
  capacity: 'queue_full',
};

/** Written as soon as a source first appears in a window; the rest only when it ends. */
const IMMEDIATE: ReadonlySet<RefusalKind> = new Set(['denied', 'capacity']);

/** Actions unauthenticated traffic can produce; they have their own retention budget. */
export const UNAUTHENTICATED_REFUSAL_ACTIONS: readonly AdminAuditAction[] = [ACTIONS.auth_failed, ACTIONS.rate_limited];
/** Refusals of verified listeners; a second budget, so floods cannot push them out either. */
export const LISTENER_REFUSAL_ACTIONS: readonly AdminAuditAction[] = [ACTIONS.denied, ACTIONS.capacity];
/** Every refusal total; none of them count toward the global audit cap. */
export const REFUSAL_ACTIONS: readonly AdminAuditAction[] = [...UNAUTHENTICATED_REFUSAL_ACTIONS, ...LISTENER_REFUSAL_ACTIONS];

export const REFUSAL_WINDOW_MS = 5 * 60_000;
export const REFUSAL_SOURCES_PER_WINDOW = 50;
/** Retention budget for each of the two refusal groups. */
export const REFUSAL_RETENTION_MAX_ROWS = 10_000;
/** Distinct sources an overflow row counts exactly; beyond this it reports a lower bound. */
const OVERFLOW_SOURCES_COUNTED = 10_000;

/** Actor name of the row that holds a window's refusals beyond the per-window limit. */
export const OVERFLOW_ACTOR = 'listener-remote:other-sources';

export interface RefusalEvent {
  kind: RefusalKind;
  /** Hashed source: `listener:<sha256>` or `address:<sha256>`. Never raw identity or address text. */
  source: string;
  connectionId?: number;
  virtualServerId?: number;
  botId?: number;
  /** Short fixed label of what was attempted, e.g. `add` or `exchange`. */
  detail?: string;
}

interface Entry {
  event: RefusalEvent;
  count: number;
  first: Date;
  last: Date;
  /** Set once the row was written immediately; the window's end updates its total. */
  operationId?: string;
  /** The immediate write, awaited before its total is updated. */
  written?: Promise<boolean>;
}

interface Overflow {
  count: number;
  sources: Set<string>;
  first: Date;
  last: Date;
}

export interface RefusalAuditOptions {
  windowMs?: number;
  sourcesPerWindow?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

/** `n=<count>` plus context, within the 64-character target id. */
function targetId(count: number, event?: RefusalEvent, sources?: string): string {
  const parts = [`n=${count}`];
  if (sources !== undefined) parts.push(`sources=${sources}`);
  if (event?.botId !== undefined) parts.push(`bot=${event.botId}`);
  if (event?.detail) parts.push(event.detail.replace(/[^a-z_]/g, '').slice(0, 16));
  return parts.join(';').slice(0, 64);
}

/** An error's code or name only: storage errors can quote the data they failed on. */
function errorKind(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  return code || (err instanceof Error ? err.name : 'error');
}

export class ListenerRemoteRefusalAudit {
  private entries = new Map<string, Entry>();
  /** Sources seen per kind this window; the per-window limit counts these, not entries. */
  private sources = new Map<RefusalKind, Set<string>>();
  private overflow = new Map<RefusalKind, Overflow>();
  private validation = 0;
  private unavailable = 0;
  private readonly pendingWrites = new Set<Promise<boolean>>();
  private timer?: NodeJS.Timeout;
  private readonly windowMs: number;
  private readonly sourcesPerWindow: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly prisma: PrismaClient, options: RefusalAuditOptions = {}) {
    this.windowMs = options.windowMs ?? REFUSAL_WINDOW_MS;
    this.sourcesPerWindow = options.sourcesPerWindow ?? REFUSAL_SOURCES_PER_WINDOW;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** Flush every window; returns a stop function that flushes what is left. */
  start(): () => Promise<void> {
    this.timer = setInterval(() => void this.flush(), this.windowMs);
    this.timer.unref();
    return async () => {
      clearInterval(this.timer);
      await this.flush();
      await Promise.all([...this.pendingWrites]);
    };
  }

  /** Count one refusal. Synchronous and never throws. */
  record(event: RefusalEvent): void {
    try {
      const at = this.now();
      const key = [event.kind, event.source, event.connectionId ?? '', event.virtualServerId ?? '', event.botId ?? '', event.detail ?? ''].join('|');
      const entry = this.entries.get(key);
      if (entry) {
        entry.count++;
        entry.last = at;
        return;
      }
      const seen = this.sources.get(event.kind) ?? new Set<string>();
      this.sources.set(event.kind, seen);
      if (!seen.has(event.source) && seen.size >= this.sourcesPerWindow) {
        const overflow = this.overflow.get(event.kind) ?? { count: 0, sources: new Set<string>(), first: at, last: at };
        overflow.count++;
        overflow.last = at;
        if (overflow.sources.size < OVERFLOW_SOURCES_COUNTED) overflow.sources.add(event.source);
        this.overflow.set(event.kind, overflow);
        return;
      }
      seen.add(event.source);
      const created: Entry = { event, count: 1, first: at, last: at };
      this.entries.set(key, created);
      if (IMMEDIATE.has(event.kind)) {
        created.operationId = randomUUID();
        created.written = this.write([this.row(created)]);
        this.pendingWrites.add(created.written);
        void created.written.finally(() => this.pendingWrites.delete(created.written!));
      }
    } catch (err) {
      this.log(`[audit] Could not count a listener remote refusal: ${errorKind(err)}`);
    }
  }

  /** Count a routine validation refusal (logged per window, never written to the audit log). */
  countValidation(): void {
    this.validation++;
  }

  /** Count a request refused because something was unavailable or timed out before any audit attempt. */
  countUnavailable(): void {
    this.unavailable++;
  }

  /** Write the window's totals and start a new window. */
  async flush(): Promise<void> {
    const entries = [...this.entries.values()];
    const overflow = [...this.overflow.entries()];
    const validation = this.validation;
    const unavailable = this.unavailable;
    this.entries = new Map();
    this.sources = new Map();
    this.overflow = new Map();
    this.validation = 0;
    this.unavailable = 0;
    if (validation > 0) this.log(`[listener-remote] Refused ${validation} invalid request(s) in the last window`);
    if (unavailable > 0) this.log(`[listener-remote] Could not check ${unavailable} request(s) in the last window (unavailable or timed out)`);

    const rows = entries.filter((entry) => !entry.operationId).map((entry) => this.row(entry));
    for (const [kind, totals] of overflow) {
      rows.push(this.overflowRow(kind, totals));
      this.log(`[audit] Listener remote ${kind} refusals from more than ${this.sourcesPerWindow} sources in one window; extra sources were combined into one row`);
    }
    await this.write(rows);
    for (const entry of entries) {
      if (!entry.operationId || entry.count === 1) continue;
      // The first row must exist before its total is updated.
      if (!(await entry.written)) continue;
      try {
        const updated = await this.prisma.adminAuditEvent.updateMany({
          where: { operationId: entry.operationId },
          data: { targetId: targetId(entry.count, entry.event), completedAt: entry.last },
        });
        if (updated.count === 0) this.log('[audit] A listener remote refusal total found no row to update');
      } catch (err) {
        this.log(`[audit] Could not update a listener remote refusal total: ${errorKind(err)}`);
      }
    }
  }

  private row(entry: Entry) {
    const { event } = entry;
    return {
      ...buildRow({
        actor: { id: 0, username: event.source },
        action: ACTIONS[event.kind],
        connectionId: event.connectionId ?? null,
        virtualServerId: event.virtualServerId ?? null,
        target: { type: 'listener_remote_refusals', id: targetId(entry.count, event) },
        operationId: entry.operationId ?? randomUUID(),
        outcome: 'failure',
        resultCode: RESULTS[event.kind],
        completedAt: entry.last,
      }),
      createdAt: entry.first,
    };
  }

  private overflowRow(kind: RefusalKind, totals: Overflow) {
    return {
      ...buildRow({
        actor: { id: 0, username: OVERFLOW_ACTOR },
        action: ACTIONS[kind],
        target: {
          type: 'listener_remote_refusals',
          id: targetId(totals.count, undefined, `${totals.sources.size}${totals.sources.size >= OVERFLOW_SOURCES_COUNTED ? '+' : ''}`),
        },
        operationId: randomUUID(),
        outcome: 'failure',
        resultCode: RESULTS[kind],
        completedAt: totals.last,
      }),
      createdAt: totals.first,
    };
  }

  /** Write rows; resolves false (after logging) when they could not be written. */
  private async write(rows: ReturnType<ListenerRemoteRefusalAudit['row']>[]): Promise<boolean> {
    if (rows.length === 0) return true;
    try {
      await this.prisma.adminAuditEvent.createMany({ data: rows });
      return true;
    } catch (err) {
      this.log(`[audit] Could not write ${rows.length} listener remote refusal row(s): ${errorKind(err)}`);
      return false;
    }
  }
}
