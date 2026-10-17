/**
 * Bounded audit retention: 30 days or 100,000 rows, whichever first, with
 * listener remote access refusals and rate limits capped separately first.
 * Chunked deletes to avoid long locks on SQLite.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import {
  AUDIT_RETENTION_DELETE_CHUNK,
  AUDIT_RETENTION_MAX_AGE_DAYS,
  AUDIT_RETENTION_MAX_ROWS,
} from './writer.js';
import { REFUSAL_RETENTION_MAX_ROWS, UNAUTHENTICATED_REFUSAL_ACTIONS } from './listener-remote-refusals.js';

const TICK_MS = 15 * 60 * 1000;
/** Pending attempts older than this are treated as ambiguous completion. */
const STALE_PENDING_MS = 15 * 60 * 1000;

export async function resolveStalePendingAttempts(prisma: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PENDING_MS);
  const result = await prisma.adminAuditEvent.updateMany({
    where: {
      outcome: 'pending',
      createdAt: { lt: cutoff },
    },
    data: {
      outcome: 'unknown',
      resultCode: 'unknown',
      completedAt: new Date(),
    },
  });
  return result.count;
}

export async function runAuditRetentionOnce(prisma: PrismaClient): Promise<{ deleted: number; staleResolved: number }> {
  let deleted = 0;
  const staleResolved = await resolveStalePendingAttempts(prisma);

  const cutoff = new Date(Date.now() - AUDIT_RETENTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  // Age-based purge
  for (;;) {
    const old = await prisma.adminAuditEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: AUDIT_RETENTION_DELETE_CHUNK,
    });
    if (old.length === 0) break;
    const result = await prisma.adminAuditEvent.deleteMany({
      where: { id: { in: old.map((r) => r.id) } },
    });
    deleted += result.count;
    if (old.length < AUDIT_RETENTION_DELETE_CHUNK) break;
  }

  // Listener remote access refusals and rate limits, which unauthenticated traffic can
  // cause, have their own budget first, so they never push other records out.
  const refusals = { action: { in: [...UNAUTHENTICATED_REFUSAL_ACTIONS] } };
  for (;;) {
    const total = await prisma.adminAuditEvent.count({ where: refusals });
    if (total <= REFUSAL_RETENTION_MAX_ROWS) break;
    const oldest = await prisma.adminAuditEvent.findMany({
      where: refusals,
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(total - REFUSAL_RETENTION_MAX_ROWS, AUDIT_RETENTION_DELETE_CHUNK),
    });
    if (oldest.length === 0) break;
    const result = await prisma.adminAuditEvent.deleteMany({ where: { id: { in: oldest.map((r) => r.id) } } });
    deleted += result.count;
  }

  // Row-count cap: keep newest MAX_ROWS
  for (;;) {
    const total = await prisma.adminAuditEvent.count();
    if (total <= AUDIT_RETENTION_MAX_ROWS) break;
    const overflow = Math.min(total - AUDIT_RETENTION_MAX_ROWS, AUDIT_RETENTION_DELETE_CHUNK);
    const oldest = await prisma.adminAuditEvent.findMany({
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: overflow,
    });
    if (oldest.length === 0) break;
    const result = await prisma.adminAuditEvent.deleteMany({
      where: { id: { in: oldest.map((r) => r.id) } },
    });
    deleted += result.count;
  }

  return { deleted, staleResolved };
}

export function startAuditRetention(prisma: PrismaClient): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { deleted, staleResolved } = await runAuditRetentionOnce(prisma);
      if (deleted > 0 || staleResolved > 0) {
        console.log(`[audit] Retention removed ${deleted} event(s); resolved ${staleResolved} stale pending`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[audit] Retention tick failed: ${msg}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  return () => clearInterval(timer);
}
