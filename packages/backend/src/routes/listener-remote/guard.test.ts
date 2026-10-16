import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { ListenerRemoteError, ListenerRemoteService, type Binding } from '../../voice/listener-remote.js';
import { endpoint, listenerRemoteIpGuard, listenerRemoteRateKey } from './shared.js';

const binding: Binding = { botId: 7, serverConfigId: 1, virtualServerId: 1, channelId: 3, clid: 9, uid: 'uid' };

async function fixture() {
  let now = 1_000;
  const remote = new ListenerRemoteService(() => now);
  const app = express();
  app.set('trust proxy', true);
  app.locals.listenerRemote = remote;
  const keys: string[] = [];
  const limiter = rateLimit({ windowMs: 60_000, max: 1_000, standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: (req, res) => {
    const key = listenerRemoteRateKey(req, res);
    keys.push(key);
    return key;
  } });
  app.use('/remote', listenerRemoteIpGuard, limiter);
  app.post('/remote/exchange', (_req, res) => { res.json({ ok: true }); });
  app.get('/remote/state', (_req, res) => { res.json({ ok: true }); });
  app.get('/thrown/:retry', endpoint(async (req) => {
    const retry = req.params.retry === 'none' ? undefined : Number(req.params.retry);
    throw new ListenerRemoteError(429, 'rate_limited', 'Too many remote requests', retry);
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: path.includes('exchange') ? 'POST' : 'GET', headers });
  const session = (await remote.exchange(remote.issue(binding).token, async () => true)).session;
  return {
    remote, request, session, keys, advance: (ms: number) => { now += ms; },
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

const bearer = (value: string) => ({ Authorization: `Bearer ${value}` });

describe('listener remote address guard', () => {
  it('lets a live session through when its address is exhausted, and keys it by listener', async () => using(async f => {
    for (let n = 0; n < 120; n++) {
      assert.equal((await f.request('/remote/state', { ...bearer('u'.repeat(43)), 'X-Forwarded-For': '192.0.2.1' })).status, 200);
    }
    const refused = await f.request('/remote/state', { ...bearer('u'.repeat(43)), 'X-Forwarded-For': '192.0.2.1' });
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { error: 'Too many remote requests', code: 'rate_limited' });
    f.keys.length = 0;
    const live = await f.request('/remote/state', { ...bearer(f.session), 'X-Forwarded-For': '192.0.2.1' });
    assert.equal(live.status, 200);
    assert.equal(live.headers.get('ratelimit-limit'), '1000');
    assert.equal(f.keys.length, 1);
    assert.match(f.keys[0], /^listener:[0-9a-f]{64}$/);
  }));

  it('gives one IPv6 /64 one budget and IPv4-mapped addresses their IPv4 budget', async () => using(async f => {
    for (let n = 0; n < 10; n++) {
      const host = `2001:db8:1:2::${(n + 1).toString(16)}`;
      assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': host })).status, 200);
    }
    assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': '2001:0db8:0001:0002:ffff:0:0:1' })).status, 429);
    assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': '2001:db8:1:3::1' })).status, 200);
    for (let n = 0; n < 10; n++) {
      assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': n % 2 ? '192.0.2.1' : '::ffff:192.0.2.1' })).status, 200);
    }
    assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': '::ffff:c000:201' })).status, 429);
    assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': '::ffff:192.0.2.2' })).status, 200);
  }));

  it('falls back to the connecting peer when the forwarded address is not an IP', async () => using(async f => {
    for (let n = 0; n < 10; n++) {
      assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': `not-an-ip-${n}` })).status, 200);
    }
    // All of them were the peer 127.0.0.1, which now has no exchange budget left.
    assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': 'still-not-an-ip' })).status, 429);
    assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': '127.0.0.1' })).status, 429);
    assert.equal((await f.request('/remote/exchange', { 'X-Forwarded-For': '127.0.0.2' })).status, 200);
  }));

  it('sends the seconds left in the window as Retry-After', async () => using(async f => {
    for (let n = 0; n < 10; n++) await f.request('/remote/exchange', { 'X-Forwarded-For': '198.51.100.1' });
    f.advance(15_000);
    const refused = await f.request('/remote/exchange', { 'X-Forwarded-For': '198.51.100.1' });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '45');
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    assert.equal((await f.request('/thrown/7')).headers.get('retry-after'), '7');
    // 429s without a rate window (a full queue, a pending link) keep the previous value.
    assert.equal((await f.request('/thrown/none')).headers.get('retry-after'), '60');
  }));
});
