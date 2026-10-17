import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ListenerRemoteService, type Binding } from './voice/listener-remote.js';
import type { BoundedRateLimitStore } from './utils/rate-windows.js';
import { ListenerRemoteRefusalAudit } from './audit/listener-remote-refusals.js';

let musicDir = '';
let previousMusicDir: string | undefined;

before(async () => {
  musicDir = await mkdtemp(join(tmpdir(), 'ts6-rate-limits-test-'));
  previousMusicDir = process.env.MUSIC_DIR;
  process.env.MUSIC_DIR = musicDir;
});

after(async () => {
  if (previousMusicDir === undefined) delete process.env.MUSIC_DIR;
  else process.env.MUSIC_DIR = previousMusicDir;
  await rm(musicDir, { recursive: true, force: true });
});

async function fixture() {
  const app = (await import('./app.js')).createApp();
  // As behind the bundled proxy: the loopback peer reports the client in X-Forwarded-For.
  app.set('trust proxy', 'loopback');
  const remote = new ListenerRemoteService();
  app.locals.listenerRemote = remote;
  const refusalRows: Record<string, unknown>[] = [];
  const refusals = new ListenerRemoteRefusalAudit({ adminAuditEvent: {
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => { refusalRows.push(...data); return { count: data.length }; },
    updateMany: async () => ({ count: 1 }),
  } } as any, { log: () => {} });
  app.locals.listenerRemoteRefusals = refusals;
  const stores = app.locals.rateLimitStores as { remoteAddress: BoundedRateLimitStore; remoteListener: BoundedRateLimitStore; auth: BoundedRateLimitStore };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api`;
  const remoteState = (from?: string, session?: string) => fetch(`${base}/listener-remote/state`, {
    headers: { ...(from ? { 'X-Forwarded-For': from } : {}), ...(session ? { Authorization: `Bearer ${session}` } : {}) },
  });
  const refresh = (from?: string) => fetch(`${base}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(from ? { 'X-Forwarded-For': from } : {}) }, body: '{}',
  });
  return {
    remote, stores, remoteState, refresh, refusalRows, flushRefusals: () => refusals.flush(), base,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function using(fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await fn(f); } finally { await f.close(); }
}

async function flood(count: number, send: (from: string) => Promise<Response>) {
  const statuses = new Set<number>();
  for (let start = 0; start < count; start += 50) {
    const batch = [];
    for (let i = start; i < Math.min(count, start + 50); i++) {
      batch.push(send(i % 2 ? `2001:db8:${(i >> 16) & 0xffff}:${i & 0xffff}::1` : `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`));
    }
    for (const response of await Promise.all(batch)) {
      statuses.add(response.status);
      await response.body?.cancel();
    }
  }
  return statuses;
}

describe('app rate limiter stores', () => {
  it('stay bounded on the listener remote path under many distinct addresses', async () => using(async f => {
    const statuses = await flood(10_500, from => f.remoteState(from));
    assert.ok(!statuses.has(503), [...statuses].join());
    const guard = f.remote as unknown as { rates: { size: number }; credentialRates: { size: number } };
    assert.ok(guard.rates.size <= 10_000);
    assert.equal(guard.credentialRates.size, 0);
    assert.ok(f.stores.remoteAddress.size <= 10_000);
    assert.equal(f.stores.remoteListener.size, 0);
    const fresh = await f.remoteState('198.51.100.200');
    assert.equal(fresh.status, 401);
  }));

  it('stay bounded on the sign-in path under many distinct addresses', async () => using(async f => {
    for (let i = 0; i < 100_000; i++) f.stores.auth.increment(`earlier-${i}`);
    await flood(2_000, from => f.refresh(from));
    assert.equal(f.stores.auth.size, 100_000);
    assert.notEqual((await f.refresh('198.51.100.200')).status, 429);
  }));

  it('take their window and limit from each limiter', async () => using(async f => {
    assert.deepEqual([f.stores.remoteAddress.windowMs, f.stores.remoteAddress.limit], [60_000, 120]);
    assert.deepEqual([f.stores.remoteListener.windowMs, f.stores.remoteListener.limit], [60_000, 120]);
    assert.deepEqual([f.stores.auth.windowMs, f.stores.auth.limit], [15 * 60_000, 15]);
  }));

  it('admit a fresh sign-in client when the store is full of exhausted windows', async () => using(async f => {
    for (let i = 0; i < 100_000; i++) {
      for (let n = 0; n < 16; n++) f.stores.auth.increment(`flood-${i}`);
    }
    assert.equal(f.stores.auth.size, 100_000);
    for (let n = 0; n < 15; n++) assert.notEqual((await f.refresh('198.51.100.30')).status, 429);
    assert.equal((await f.refresh('198.51.100.30')).status, 429);
    assert.notEqual((await f.refresh('198.51.100.31')).status, 429);
    assert.equal(f.stores.auth.size, 100_000);
  }));

  it('keep a live listener out of reach of exhausted address windows', async () => using(async f => {
    const binding: Binding = { botId: 1, serverConfigId: 1, virtualServerId: 1, channelId: 1, clid: 1, uid: 'uid' };
    const { session } = await f.remote.exchange(f.remote.issue(binding).token, async () => true);
    const guard = f.remote as unknown as { rates: { size: number } };
    for (let i = 0; i < 10_000; i++) {
      const key = `10.1.${i >> 8}.${i & 255}`;
      for (let n = 0; n < 121; n++) {
        f.stores.remoteAddress.increment(`ipv4:${key}`);
        try { f.remote.checkIp(`ipv4:${key}`, false); } catch { /* exhausted */ }
      }
    }
    assert.equal(guard.rates.size, 10_000);
    assert.equal(f.stores.remoteAddress.size, 10_000);
    const live = await f.remoteState('10.1.0.1', session);
    // The route itself rejects the session (no bot in this app); the limiters let it through.
    assert.equal(live.status, 401);
    assert.equal(live.headers.get('ratelimit-limit'), '120');
    assert.equal(live.headers.get('ratelimit-remaining'), '119');
    assert.equal(f.stores.remoteListener.size, 1);
    assert.equal((await f.remoteState('10.1.0.2')).status, 429);
    assert.equal((await f.remoteState('198.51.100.40')).status, 401);
  }));

  it('record limiter and guard refusals as totals with a fixed route label and keyed address hash', async () => using(async f => {
    for (let n = 0; n < 121; n++) f.stores.remoteAddress.increment('ipv4:198.51.100.7');
    const limited = await f.remoteState('198.51.100.7');
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'Too many remote requests', code: 'rate_limited' }, 'the response is unchanged');
    assert.equal((await f.remoteState('198.51.100.7')).status, 429, 'a repeat adds to the same total');
    for (let n = 0; n < 200; n++) {
      try { f.remote.checkIp('ipv4:198.51.100.8', false); } catch { /* exhausted */ }
    }
    const guarded = await fetch(`${f.base}/listener-remote/secret-looking-path-text`, { headers: { 'X-Forwarded-For': '198.51.100.8' } });
    assert.equal(guarded.status, 429);
    await f.flushRefusals();
    const rows = f.refusalRows as any[];
    assert.deepEqual(rows.map((row) => [row.action, row.targetId]).sort(), [
      ['listener.remote.rate_limited', 'n=1;other'],
      ['listener.remote.rate_limited', 'n=2;limiter'],
    ]);
    const { createHash } = await import('node:crypto');
    for (const row of rows) {
      assert.match(row.actorUsername, /^address:[0-9a-f]{64}$/);
      for (const key of ['ipv4:198.51.100.7', 'ipv4:198.51.100.8']) {
        assert.notEqual(row.actorUsername, `address:${createHash('sha256').update(key).digest('hex')}`, 'not a plain, reversible hash');
      }
    }
    assert.ok(!JSON.stringify(rows).includes('secret'));
  }));

  it('record a live listener\'s rate limit under the same fingerprint as its other records', async () => using(async f => {
    const binding: Binding = { botId: 1, serverConfigId: 1, virtualServerId: 1, channelId: 1, clid: 1, uid: 'uid-for-fingerprint' };
    const { session } = await f.remote.exchange(f.remote.issue(binding).token, async () => true);
    const key = f.remote.sessionRateKey(session)!;
    for (let n = 0; n < 121; n++) f.stores.remoteListener.increment(key);
    assert.equal((await f.remoteState('10.9.0.1', session)).status, 429);
    await f.flushRefusals();
    const { createHash } = await import('node:crypto');
    const limited = (f.refusalRows as any[]).find((row) => row.action === 'listener.remote.rate_limited');
    assert.equal(limited?.actorUsername, `listener:${createHash('sha256').update(binding.uid).digest('hex')}`);
  }));

  it('group sign-in attempts per IPv6 /64', async () => using(async f => {
    for (let n = 1; n <= 15; n++) assert.notEqual((await f.refresh(`2001:db8:a:b::${n.toString(16)}`)).status, 429);
    assert.equal((await f.refresh('2001:0db8:000a:000b:ffff:ffff:ffff:ffff')).status, 429);
    assert.notEqual((await f.refresh('2001:db8:a:c::1')).status, 429);
  }));

  it('key sign-in attempts by the connecting peer when the forwarded address is not an IP', async () => using(async f => {
    for (let n = 0; n < 15; n++) assert.notEqual((await f.refresh(`not-an-ip-${n}`)).status, 429);
    assert.equal((await f.refresh('still-not-an-ip')).status, 429);
    assert.equal((await f.refresh()).status, 429);
    assert.equal((await f.refresh('::ffff:127.0.0.1')).status, 429);
    assert.notEqual((await f.refresh('127.0.0.2')).status, 429);
  }));
});
