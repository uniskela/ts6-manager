import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runAuditRetentionOnce } from './retention.js';
import { AUDIT_RETENTION_MAX_ROWS } from './writer.js';
import { REFUSAL_RETENTION_MAX_ROWS } from './listener-remote-refusals.js';

function createRetentionPrisma(initial: Array<{ id: string; createdAt: Date; outcome?: string; action?: string }>) {
  let rows = initial.map((r) => ({ outcome: 'success', action: 'client.kick', ...r }));
  type Where = { action?: { in?: string[] }; NOT?: { action?: { in?: string[] } } };
  const matches = (row: { action: string }, where?: Where) =>
    (!where?.action?.in || where.action.in.includes(row.action))
    && (!where?.NOT?.action?.in || !where.NOT.action.in.includes(row.action));
  return {
    prisma: {
      adminAuditEvent: {
        updateMany: async ({ where, data }: { where: any; data: any }) => {
          let count = 0;
          for (const row of rows) {
            if (where.outcome && row.outcome !== where.outcome) continue;
            if (where.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        },
        findMany: async ({
          where,
          orderBy,
          take,
          select,
        }: {
          where?: { createdAt?: { lt?: Date }; id?: { in?: string[] } } & Where;
          orderBy?: unknown;
          take?: number;
          select?: { id?: boolean };
        }) => {
          void orderBy;
          void select;
          let list = rows.filter((r) => matches(r, where));
          if (where?.createdAt?.lt) {
            list = list.filter((r) => r.createdAt < where.createdAt!.lt!);
            list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          } else {
            list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          }
          return list.slice(0, take ?? list.length).map((r) => ({ id: r.id }));
        },
        deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          const ids = new Set(where.id.in);
          const before = rows.length;
          rows = rows.filter((r) => !ids.has(r.id));
          return { count: before - rows.length };
        },
        count: async (args?: { where?: Where }) => rows.filter((r) => matches(r, args?.where)).length,
      },
    } as any,
    getRows: () => rows,
  };
}

describe('audit retention', () => {
  it('deletes rows older than 30 days', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date();
    const { prisma, getRows } = createRetentionPrisma([
      { id: 'old1', createdAt: old },
      { id: 'new1', createdAt: recent },
    ]);
    const { deleted } = await runAuditRetentionOnce(prisma);
    assert.equal(deleted, 1);
    assert.deepEqual(getRows().map((r) => r.id), ['new1']);
  });

  it('prunes listener remote refusal totals against their own budget first', async () => {
    const now = Date.now();
    const refusals = Array.from({ length: REFUSAL_RETENTION_MAX_ROWS + 2 }, (_, i) => ({
      id: `f${i}`, action: i % 2 ? 'listener.remote.auth_failed' : 'listener.remote.rate_limited',
      createdAt: new Date(now - (REFUSAL_RETENTION_MAX_ROWS + 2 - i) * 1000),
    }));
    // Older than every refusal row, but outside the refusal budget.
    const admin = { id: 'admin', action: 'client.ban', createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000) };
    const denied = { id: 'denied', action: 'listener.remote.denied', createdAt: new Date(now - 9 * 24 * 60 * 60 * 1000) };
    const { prisma, getRows } = createRetentionPrisma([admin, denied, ...refusals]);
    await runAuditRetentionOnce(prisma);
    const ids = new Set(getRows().map((r) => r.id));
    assert.ok(ids.has('admin') && ids.has('denied'), 'other records are kept');
    assert.equal(getRows().length, REFUSAL_RETENTION_MAX_ROWS + 2);
    assert.ok(!ids.has('f0') && !ids.has('f1') && ids.has('f2'), 'the oldest refusal totals go first');
  });

  it('never lets refusal totals push administrative records out, even at the global cap', async () => {
    const now = Date.now();
    const admin = Array.from({ length: AUDIT_RETENTION_MAX_ROWS }, (_, i) => ({
      id: `a${i}`, action: 'client.kick', createdAt: new Date(now - (AUDIT_RETENTION_MAX_ROWS - i) * 1000),
    }));
    const refusals = Array.from({ length: 20 }, (_, i) => ({
      id: `x${i}`, action: i % 2 ? 'listener.remote.denied' : 'listener.remote.auth_failed', createdAt: new Date(now),
    }));
    const { prisma, getRows } = createRetentionPrisma([...admin, ...refusals]);
    await runAuditRetentionOnce(prisma);
    assert.equal(getRows().filter((r) => r.action === 'client.kick').length, AUDIT_RETENTION_MAX_ROWS);
    assert.equal(getRows().length, AUDIT_RETENTION_MAX_ROWS + 20);
  });

  it('keeps permission-denial totals within their own budget, apart from unauthenticated ones', async () => {
    const now = Date.now();
    const flood = Array.from({ length: REFUSAL_RETENTION_MAX_ROWS + 5 }, (_, i) => ({
      id: `u${i}`, action: 'listener.remote.auth_failed', createdAt: new Date(now - 1000 + i),
    }));
    const denied = Array.from({ length: REFUSAL_RETENTION_MAX_ROWS + 3 }, (_, i) => ({
      id: `d${i}`, action: 'listener.remote.denied', createdAt: new Date(now - 100_000 + i),
    }));
    const { prisma, getRows } = createRetentionPrisma([...denied, ...flood]);
    await runAuditRetentionOnce(prisma);
    assert.equal(getRows().filter((r) => r.action === 'listener.remote.denied').length, REFUSAL_RETENTION_MAX_ROWS);
    assert.equal(getRows().filter((r) => r.action === 'listener.remote.auth_failed').length, REFUSAL_RETENTION_MAX_ROWS);
  });

  it('enforces max row count by deleting oldest first', async () => {
    const now = Date.now();
    const initial = Array.from({ length: AUDIT_RETENTION_MAX_ROWS + 3 }, (_, i) => ({
      id: `r${i}`,
      createdAt: new Date(now - (AUDIT_RETENTION_MAX_ROWS + 3 - i) * 1000),
    }));
    const { prisma, getRows } = createRetentionPrisma(initial);
    await runAuditRetentionOnce(prisma);
    assert.equal(getRows().length, AUDIT_RETENTION_MAX_ROWS);
    assert.equal(getRows()[0].id, 'r3');
  });

  it('marks stale pending attempts as unknown', async () => {
    const stale = new Date(Date.now() - 20 * 60 * 1000);
    const fresh = new Date();
    const { prisma, getRows } = createRetentionPrisma([
      { id: 'p1', createdAt: stale, outcome: 'pending' },
      { id: 'p2', createdAt: fresh, outcome: 'pending' },
    ]);
    const { staleResolved } = await runAuditRetentionOnce(prisma);
    assert.equal(staleResolved, 1);
    assert.equal(getRows().find((r) => r.id === 'p1')?.outcome, 'unknown');
    assert.equal(getRows().find((r) => r.id === 'p2')?.outcome, 'pending');
  });
});
