import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoundedRateLimitStore, RateWindows } from './rate-windows.js';

function clock() {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('bounded rate windows', () => {
  it('drops expired windows before anything else', () => {
    const { now, advance } = clock();
    const windows = new RateWindows(2, 10_000, now);
    windows.hit('a', 3);
    advance(5_000);
    windows.hit('b', 3);
    windows.hit('b', 3);
    advance(5_000);
    windows.hit('c', 3);
    assert.deepEqual([...windows.keys()], ['b', 'c']);
  });

  it('evicts the under-limit window with the fewest hits, oldest first, and keeps exhausted ones', () => {
    const { now } = clock();
    const windows = new RateWindows(3, 60_000, now);
    for (let i = 0; i < 2; i++) windows.hit('exhausted', 2);
    windows.hit('twice', 3);
    windows.hit('twice', 3);
    windows.hit('once', 3);
    windows.hit('new-1', 3);
    assert.deepEqual([...windows.keys()], ['exhausted', 'twice', 'new-1']);
    windows.hit('new-2', 3);
    assert.deepEqual([...windows.keys()], ['exhausted', 'twice', 'new-2']);
    assert.equal(windows.hit('exhausted', 2).count, 3);
  });

  it('refuses only the new key when every window is exhausted, until the earliest expires', () => {
    const { now, advance } = clock();
    const windows = new RateWindows(2, 60_000, now);
    windows.hit('a', 1);
    advance(10_000);
    windows.hit('b', 1);
    const refused = windows.hit('c', 1);
    assert.ok(refused.count > refused.max);
    assert.equal(refused.expiresAt, 61_000);
    assert.deepEqual([...windows.keys()], ['a', 'b']);
    assert.ok(windows.hit('a', 1).count > 1);
    advance(50_000);
    assert.equal(windows.hit('c', 1).count, 1);
    assert.deepEqual([...windows.keys()], ['b', 'c']);
  });

  it('serves express-rate-limit without growing past its capacity', () => {
    const { now, advance } = clock();
    const store = new BoundedRateLimitStore({ windowMs: 60_000, limit: 2, capacity: 100, now });
    for (let i = 0; i < 1_000; i++) store.increment(`key-${i}`);
    assert.equal(store.size, 100);
    assert.deepEqual(store.increment('key-999'), { totalHits: 2, resetTime: new Date(61_000) });
    store.decrement('key-999');
    assert.equal(store.get('key-999')?.totalHits, 1);
    store.resetKey('key-999');
    assert.equal(store.get('key-999'), undefined);
    advance(60_000);
    assert.equal(store.get('key-998'), undefined);
    store.resetAll();
    assert.equal(store.size, 0);
  });
});
