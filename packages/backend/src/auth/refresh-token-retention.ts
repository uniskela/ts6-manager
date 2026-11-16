/**
 * Refresh-token retention (P1 F-1).
 *
 * Expired refresh rows (live and consumed) are purged on a background tick, not
 * on every unauthenticated `/api/auth/refresh`. Request-path full-table
 * `deleteMany` contended with admin reset/disable and replay-family revoke under
 * concurrent invalid refresh storms (independent review F-1).
 *
 * Policy:
 * - Delete rows with `expiresAt` in the past (live and consumed keep their mint/rotate
 *   `expiresAt`; this purge is retention only).
 * - Chunked deletes to keep each write short on SQLite.
 * - Tick every 15 minutes; overlapping ticks are skipped.
 * - Tick failures are logged and never surface to login/refresh/reset/disable.
 *
 * Replay detection vs expiry (do not conflate):
 * - An *unconsumed* token past `expiresAt` is rejected without family revoke.
 * - A *consumed* token (`replacedBy` set) is checked for reuse **before** the
 *   expiry branch. While that row still exists, presenting it again revokes the
 *   family even if `expiresAt` is already past. Background retention eventually
 *   removes the row; until then replay detection remains active. There is no
 *   grace period that skips revoke after expiry.
 *
 * Limitations:
 * - Between ticks, expired rows may linger (bounded by the interval + chunk lag).
 * - `stopRefreshTokenRetention()` cancels future ticks; it does not wait for an
 *   in-flight sweep to finish.
 * - Single-process design: multiple backends each run their own tick (idempotent).
 * - No row-count cap beyond expiry; volume tracks active sessions × 7-day TTL.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

const TICK_MS = 15 * 60 * 1000;
const DELETE_CHUNK = 500;

export async function runRefreshTokenRetentionOnce(prisma: PrismaClient): Promise<number> {
  let deleted = 0;
  const now = new Date();
  for (;;) {
    const expired = await prisma.refreshToken.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: DELETE_CHUNK,
    });
    if (expired.length === 0) break;
    const result = await prisma.refreshToken.deleteMany({
      where: { id: { in: expired.map((row) => row.id) } },
    });
    deleted += result.count;
    if (expired.length < DELETE_CHUNK) break;
  }
  return deleted;
}

export function startRefreshTokenRetention(prisma: PrismaClient): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const deleted = await runRefreshTokenRetentionOnce(prisma);
      if (deleted > 0) {
        console.log(`[auth] Refresh-token retention removed ${deleted} expired row(s)`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[auth] Refresh-token retention tick failed: ${msg}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  // Do not block process start on the first purge; schedule shortly after listen.
  const startup = setTimeout(() => void tick(), 5_000);
  startup.unref?.();
  timer.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(startup);
  };
}
