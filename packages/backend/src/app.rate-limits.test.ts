import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ListenerRemoteService } from './voice/listener-remote.js';
import type { BoundedRateLimitStore } from './utils/rate-windows.js';

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
  const stores = app.locals.rateLimitStores as { remote: BoundedRateLimitStore; auth: BoundedRateLimitStore };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api`;
  const remoteState = (from?: string) => fetch(`${base}/listener-remote/state`, { headers: from ? { 'X-Forwarded-For': from } : {} });
  const refresh = (from?: string) => fetch(`${base}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(from ? { 'X-Forwarded-For': from } : {}) }, body: '{}',
  });
  return {
    remote, stores, remoteState, refresh,
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
    assert.ok(f.stores.remote.size <= 10_000);
    const fresh = await f.remoteState('198.51.100.200');
    assert.equal(fresh.status, 401);
  }));

  it('stay bounded on the sign-in path under many distinct addresses', async () => using(async f => {
    await flood(10_500, from => f.refresh(from));
    assert.ok(f.stores.auth.size <= 10_000);
    assert.notEqual((await f.refresh('198.51.100.200')).status, 429);
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
