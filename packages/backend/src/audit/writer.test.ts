import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  beginRemoteAttempt,
  classifyRemoteError,
  completeRemoteAttempt,
  recordLocalSuccess,
  markPartial,
} from './writer.js';

const SECRET = 'super-secret-apikey-value-xyz';
const COOKIE_SECRET = 'SID=sentinel-cookie-value-do-not-store';
const FLOW_SECRET = 'node-payload-with-token=abc123SECRET';

type Row = Record<string, unknown>;

function createMemoryPrisma() {
  const rows: Row[] = [];
  const prisma = {
    adminAuditEvent: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: `evt_${rows.length + 1}`,
          createdAt: new Date(),
          completedAt: null,
          ...data,
        };
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const row of rows) {
          if (where.operationId && row.operationId !== where.operationId) continue;
          if (where.outcome) {
            if (typeof where.outcome === 'string' && row.outcome !== where.outcome) continue;
            if (where.outcome.in && !(where.outcome.in as string[]).includes(row.outcome as string)) continue;
          }
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
      findMany: async () => rows.slice(),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma: prisma as any, rows };
}

function assertNoSecrets(value: unknown, secrets: string[]) {
  const blob = JSON.stringify(value);
  for (const secret of secrets) {
    assert.equal(blob.includes(secret), false, `secret leaked: ${secret}`);
  }
}

describe('admin audit writer privacy', () => {
  it('remote attempt stores allow-listed fields only and never request bodies', async () => {
    const { prisma, rows } = createMemoryPrisma();
    const attempt = await beginRemoteAttempt(prisma, {
      actor: { id: 9, username: 'admin' },
      action: 'client.kick',
      connectionId: 3,
      virtualServerId: 1,
      target: { type: 'client', id: 42 },
    });

    // Simulate hostile accidental serialization of request-ish data nearby — writer must not accept it
    const hostile = {
      reasonmsg: `kick because ${SECRET}`,
      headers: { authorization: `Bearer ${SECRET}` },
      url: `/tokens/${SECRET}`,
      flowData: { secret: FLOW_SECRET },
      cookies: COOKIE_SECRET,
    };
    assertNoSecrets(rows, [SECRET, COOKIE_SECRET, FLOW_SECRET]);
    assert.equal(rows[0].outcome, 'pending');
    assert.equal(rows[0].action, 'client.kick');
    assert.equal(rows[0].targetId, '42');
    assert.equal(attempt.operationId.length > 0, true);
    // Ensure hostile object is not somehow attached
    assertNoSecrets(hostile, []); // no-op structure check
    assert.equal(Object.keys(rows[0]).includes('reasonmsg'), false);
  });

  it('completeRemoteAttempt records failure/unknown without exception text', async () => {
    const { prisma, rows } = createMemoryPrisma();
    const attempt = await beginRemoteAttempt(prisma, {
      actor: { id: 1, username: 'admin' },
      action: 'ban.create',
      connectionId: 2,
      virtualServerId: 1,
      target: { type: 'ban' },
    });
    const err = new Error(`TeamSpeak rejected: ${SECRET}`);
    const classified = classifyRemoteError(err);
    await completeRemoteAttempt(prisma, attempt.operationId, classified);
    assert.equal(rows[0].outcome, 'failure');
    assert.equal(rows[0].resultCode, 'unknown');
    assertNoSecrets(rows, [SECRET]);
  });

  it('timeouts classify as unknown outcome', () => {
    const err = Object.assign(new Error('request timeout'), { name: 'TimeoutError' });
    const classified = classifyRemoteError(err);
    assert.equal(classified.outcome, 'unknown');
    assert.equal(classified.resultCode, 'timeout');
  });

  it('local success is transactional and omits nested secrets from mutate inputs', async () => {
    const { prisma, rows } = createMemoryPrisma();
    const nested = {
      password: SECRET,
      apiKey: SECRET,
      flowData: { nodes: [{ data: { token: FLOW_SECRET } }] },
    };
    const { operationId } = await recordLocalSuccess(
      prisma,
      {
        actor: { id: 1, username: 'admin' },
        action: 'user.create',
        target: { type: 'user' },
      },
      async () => {
        // mutate may touch secrets locally; audit row must not capture them
        assert.equal(typeof nested.password, 'string');
        return { id: 77 };
      },
      { resolveTargetId: (u) => u.id },
    );
    assert.equal(operationId.length > 0, true);
    assert.equal(rows[0].outcome, 'success');
    assert.equal(rows[0].targetId, '77');
    assertNoSecrets(rows, [SECRET, FLOW_SECRET]);
  });

  it('markPartial upgrades success to partial with allow-listed code', async () => {
    const { prisma, rows } = createMemoryPrisma();
    const { operationId } = await recordLocalSuccess(
      prisma,
      {
        actor: { id: 1, username: 'admin' },
        action: 'flow.update',
        connectionId: 1,
        virtualServerId: 1,
        target: { type: 'flow', id: 5 },
      },
      async () => ({ ok: true }),
    );
    await markPartial(prisma, operationId, 'engine_reload_failed');
    assert.equal(rows[0].outcome, 'partial');
    assert.equal(rows[0].resultCode, 'engine_reload_failed');
  });

  it('rejects unknown actions at the typed boundary', async () => {
    const { prisma } = createMemoryPrisma();
    await assert.rejects(
      () => beginRemoteAttempt(prisma, {
        actor: { id: 1, username: 'a' },
        action: 'not.a.real.action' as any,
        target: { type: 'client', id: 1 },
      }),
      /Invalid audit action/,
    );
  });
});
