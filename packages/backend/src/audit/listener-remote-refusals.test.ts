import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ListenerRemoteRefusalAudit, OVERFLOW_ACTOR } from './listener-remote-refusals.js';

function fakePrisma() {
  const writes: Array<{ kind: 'createMany' | 'updateMany'; rows: any[] }> = [];
  return {
    writes,
    prisma: {
      adminAuditEvent: {
        createMany: async ({ data }: { data: any[] }) => { writes.push({ kind: 'createMany', rows: data }); return { count: data.length }; },
        updateMany: async (query: any) => { writes.push({ kind: 'updateMany', rows: [query] }); return { count: 1 }; },
      },
    } as any,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('listener remote refusal totals', () => {
  it('writes one row per source and window however many requests arrive', async () => {
    const { prisma, writes } = fakePrisma();
    const audit = new ListenerRemoteRefusalAudit(prisma, { log: () => {} });
    for (let i = 0; i < 10_000; i++) audit.record({ kind: 'auth_failed', source: 'address:a', detail: 'state' });
    for (let i = 0; i < 5; i++) audit.record({ kind: 'rate_limited', source: 'address:b' });
    assert.equal(writes.length, 0, 'unauthenticated refusals are not written per request');
    await audit.flush();
    assert.equal(writes.length, 1, 'one batch per window');
    assert.deepEqual(writes[0].rows.map((row) => [row.action, row.targetId]), [
      ['listener.remote.auth_failed', 'n=10000;state'],
      ['listener.remote.rate_limited', 'n=5'],
    ]);
    await audit.flush();
    assert.equal(writes.length, 1, 'an empty window writes nothing');
  });

  it('combines sources beyond the per-window limit into one row that keeps the total', async () => {
    const { prisma, writes } = fakePrisma();
    const logs: string[] = [];
    const audit = new ListenerRemoteRefusalAudit(prisma, { sourcesPerWindow: 3, log: (m) => logs.push(m) });
    for (let i = 0; i < 1000; i++) audit.record({ kind: 'auth_failed', source: `address:${i}` });
    await audit.flush();
    const rows = writes[0].rows;
    assert.equal(rows.length, 4, 'three sources plus one overflow row');
    const overflow = rows.find((row) => row.actorUsername === OVERFLOW_ACTOR);
    assert.equal(overflow.targetId, 'n=997;sources=997');
    assert.equal(rows.reduce((sum, row) => sum + Number(/n=(\d+)/.exec(row.targetId)![1]), 0), 1000, 'no refusal is lost from the totals');
    assert.ok(logs.some((line) => line.includes('more than 3 sources')));
  });

  it('writes the first permission denial at once and its total at the end of the window', async () => {
    const { prisma, writes } = fakePrisma();
    const audit = new ListenerRemoteRefusalAudit(prisma, { log: () => {} });
    const denial = { kind: 'denied' as const, source: 'listener:f', connectionId: 2, virtualServerId: 3, botId: 4, detail: 'add' };
    audit.record(denial);
    await tick();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].rows[0].targetId, 'n=1;bot=4;add');
    assert.equal(writes[0].rows[0].resultCode, 'permission_denied');
    audit.record(denial);
    audit.record(denial);
    await audit.flush();
    assert.equal(writes.length, 2, 'repeats only update the total');
    assert.equal(writes[1].kind, 'updateMany');
    assert.equal(writes[1].rows[0].where.operationId, writes[0].rows[0].operationId);
    assert.equal(writes[1].rows[0].data.targetId, 'n=3;bot=4;add');
  });

  it('bounds the writes per window by the source limit, not by traffic', async () => {
    const { prisma, writes } = fakePrisma();
    const audit = new ListenerRemoteRefusalAudit(prisma, { sourcesPerWindow: 5, log: () => {} });
    for (let i = 0; i < 5000; i++) {
      audit.record({ kind: 'denied', source: `listener:${i % 50}`, botId: 1 });
      audit.record({ kind: 'capacity', source: `listener:${i % 50}`, botId: 1 });
      audit.record({ kind: 'auth_failed', source: `address:${i}` });
      audit.record({ kind: 'rate_limited', source: `address:${i}` });
    }
    await tick();
    await audit.flush();
    const rowsWritten = writes.reduce((sum, write) => sum + write.rows.length, 0);
    // Per kind: at most 5 sources (+5 total updates for the immediate kinds) and one overflow row.
    assert.equal(rowsWritten, 4 * 6 + 2 * 5, `${rowsWritten} rows`);
  });

  it('waits for a slow first write before updating its total, and drains writes on stop', async () => {
    const rows: any[] = [];
    const updates: any[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const audit = new ListenerRemoteRefusalAudit({ adminAuditEvent: {
      createMany: async ({ data }: { data: any[] }) => { await slow; rows.push(...data); return { count: data.length }; },
      updateMany: async (query: any) => { updates.push(query); return { count: rows.some((r) => r.operationId === query.where.operationId) ? 1 : 0 }; },
    } } as any, { log: () => {} });
    audit.record({ kind: 'denied', source: 'listener:f', botId: 4 });
    audit.record({ kind: 'denied', source: 'listener:f', botId: 4 });
    const flushed = audit.flush();
    await tick();
    release();
    await flushed;
    assert.equal(rows.length, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.targetId, 'n=2;bot=4');

    let releaseLater!: () => void;
    const later = new Promise<void>((resolve) => { releaseLater = resolve; });
    const stopped = new ListenerRemoteRefusalAudit({ adminAuditEvent: {
      createMany: async ({ data }: { data: any[] }) => { await later; rows.push(...data); return { count: data.length }; },
      updateMany: async () => ({ count: 1 }),
    } } as any, { log: () => {} });
    const stop = stopped.start();
    stopped.record({ kind: 'capacity', source: 'listener:g', botId: 5 });
    let done = false;
    const stopping = stop().then(() => { done = true; });
    await tick();
    assert.equal(done, false, 'stop waits for the pending write');
    releaseLater();
    await stopping;
    assert.equal(rows.length, 2);
  });

  it('runs flushes one after another and stop waits for one still running', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const audit = new ListenerRemoteRefusalAudit({ adminAuditEvent: {
      createMany: async ({ data }: { data: any[] }) => {
        const call = ++calls;
        if (call === 1) await slow;
        order.push(`write ${call}: ${data.map((row) => `${row.actorUsername}=${row.targetId}`).join(',')}`);
        return { count: data.length };
      },
      updateMany: async () => ({ count: 1 }),
    } } as any, { log: () => {} });
    const stop = audit.start();
    audit.record({ kind: 'auth_failed', source: 'address:a' });
    const first = audit.flush();
    await tick();
    // Recorded while the first flush is still writing: they belong to the next window.
    audit.record({ kind: 'auth_failed', source: 'address:b' });
    audit.record({ kind: 'auth_failed', source: 'address:b' });
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await tick();
    assert.equal(stopped, false);
    release();
    await Promise.all([first, stopping]);
    assert.deepEqual(order, ['write 1: address:a=n=1', 'write 2: address:b=n=2']);
  });

  it('says in the log, rather than losing silently, a refusal that arrives after the last flush', async () => {
    const { prisma, writes } = fakePrisma();
    const logs: string[] = [];
    const audit = new ListenerRemoteRefusalAudit(prisma, { log: (m) => logs.push(m) });
    const stop = audit.start();
    audit.record({ kind: 'auth_failed', source: 'address:a' });
    await stop();
    audit.record({ kind: 'auth_failed', source: 'address:late' });
    audit.record({ kind: 'denied', source: 'listener:late' });
    await tick();
    assert.equal(writes.length, 1, 'only the last window was written');
    assert.equal(logs.filter((line) => line.includes('after the last audit flush')).length, 1);
  });

  it('logs a refusal recorded while the last flush is still writing', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const rows: any[] = [];
    const logs: string[] = [];
    const audit = new ListenerRemoteRefusalAudit({ adminAuditEvent: {
      createMany: async ({ data }: { data: any[] }) => { await slow; rows.push(...data); return { count: data.length }; },
      updateMany: async () => ({ count: 1 }),
    } } as any, { log: (m) => logs.push(m) });
    const stop = audit.start();
    audit.record({ kind: 'auth_failed', source: 'address:a' });
    const stopping = stop();
    await tick();
    audit.record({ kind: 'auth_failed', source: 'address:during-flush' });
    release();
    await stopping;
    assert.deepEqual(rows.map((row) => row.actorUsername), ['address:a']);
    assert.ok(logs.some((line) => line.includes('after the last audit flush')), 'not lost silently');
  });

  it('never throws and logs only the kind of storage error', async () => {
    const logs: string[] = [];
    const audit = new ListenerRemoteRefusalAudit({
      adminAuditEvent: {
        createMany: async () => { throw Object.assign(new Error('row data: secret'), { code: 'P2002' }); },
        updateMany: async () => { throw new Error('row data: secret'); },
      },
    } as any, { log: (m) => logs.push(m) });
    audit.record({ kind: 'denied', source: 'listener:f' });
    audit.record({ kind: 'denied', source: 'listener:f' });
    audit.record({ kind: 'auth_failed', source: 'address:a' });
    audit.countValidation();
    await tick();
    await audit.flush();
    assert.ok(logs.some((line) => line.includes('P2002')));
    assert.ok(logs.every((line) => !line.includes('secret')));
    assert.ok(logs.some((line) => line.includes('Refused 1 invalid request')), 'routine refusals are counted in the log only');
  });
});
