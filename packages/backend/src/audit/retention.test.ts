import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runAuditRetentionOnce } from './retention.js';
import { AUDIT_RETENTION_MAX_ROWS } from './writer.js';

function createRetentionPrisma(initial: Array<{ id: string; createdAt: Date; outcome?: string }>) {
  let rows = initial.map((r) => ({ outcome: 'success', ...r }));
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
          where?: { createdAt?: { lt?: Date }; id?: { in?: string[] } };
          orderBy?: unknown;
          take?: number;
          select?: { id?: boolean };
        }) => {
          void orderBy;
          void select;
          let list = rows.slice();
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
        count: async () => rows.length,
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
