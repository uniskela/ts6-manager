import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import rateLimit from 'express-rate-limit';
import { BoundedRateLimitStore, RateWindows } from './rate-windows.js';

function clock() {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('bounded rate windows', () => {
  it('drops expired windows before anything else', () => {
    const { now, advance } = clock();
    const windows = new RateWindows(2, 10_000, now);
    windows.hit('a', [3]);
    advance(5_000);
    windows.hit('b', [3]);
    windows.hit('b', [3]);
    advance(5_000);
    windows.hit('c', [3]);
    assert.deepEqual([...windows.keys()], ['b', 'c']);
  });

  it('evicts the oldest under-limit window and keeps exhausted ones', () => {
    const { now } = clock();
    const windows = new RateWindows(3, 60_000, now);
    for (let i = 0; i < 2; i++) windows.hit('exhausted', [2]);
    windows.hit('older', [3]);
    windows.hit('older', [3]);
    windows.hit('newer', [3]);
    windows.hit('new-1', [3]);
    assert.deepEqual([...windows.keys()], ['exhausted', 'newer', 'new-1']);
    windows.hit('new-2', [3]);
    assert.deepEqual([...windows.keys()], ['exhausted', 'new-1', 'new-2']);
    assert.equal(windows.hit('exhausted', [2]).count, 3);
  });

  it('treats a window as exhausted when any of its counters is, and never splits them', () => {
    const { now } = clock();
    const windows = new RateWindows(2, 60_000, now);
    for (let i = 0; i < 2; i++) windows.hit('address', [100, 2], 1);
    windows.hit('other', [100, 2]);
    windows.hit('fresh', [100, 2]);
    assert.deepEqual([...windows.keys()], ['address', 'fresh']);
    const refused = windows.hit('address', [100, 2], 1);
    assert.ok(refused.count > refused.limit);
    assert.deepEqual(windows.get('address')?.counts, [0, 3]);
  });

  it('never refuses a new key for capacity; when every window is exhausted the oldest goes', () => {
    const { now, advance } = clock();
    const windows = new RateWindows(2, 60_000, now);
    windows.hit('a', [1]);
    advance(10_000);
    windows.hit('b', [1]);
    const admitted = windows.hit('c', [1]);
    assert.equal(admitted.count, 1);
    assert.equal(admitted.remainingMs, 60_000);
    assert.deepEqual([...windows.keys()], ['b', 'c']);
    assert.ok(windows.hit('b', [1]).count > 1);
  });

  it('puts a window that falls back under its limit back in creation order', () => {
    const { now } = clock();
    const windows = new RateWindows(3, 60_000, now);
    windows.hit('a', [2]);
    windows.hit('a', [2]);
    windows.hit('b', [2]);
    windows.hit('c', [2]);
    windows.decrement('a');
    // a is the oldest under-limit window again, so it makes room first.
    windows.hit('d', [2]);
    assert.deepEqual([...windows.keys()], ['b', 'c', 'd']);
  });

  it('keeps a window and its reset time when its count drops to zero', () => {
    const { now, advance } = clock();
    const windows = new RateWindows(3, 60_000, now);
    windows.hit('a', [2]);
    advance(10_000);
    windows.decrement('a');
    assert.deepEqual(windows.get('a'), { counts: [0], remainingMs: 50_000 });
    assert.deepEqual(windows.hit('a', [2]), { count: 1, limit: 2, remainingMs: 50_000 });
    windows.decrement('a');
    windows.decrement('a');
    assert.deepEqual(windows.get('a')?.counts, [0]);
  });

  it('does constant work per new key on a full store', () => {
    const { now } = clock();
    const windows = new RateWindows(1_000, 60_000, now);
    for (let i = 0; i < 1_000; i++) windows.hit(`open-${i}`, [5]);
    windows.scanned = 0;
    for (let i = 0; i < 10_000; i++) windows.hit(`fresh-${i}`, [5]);
    assert.ok(windows.scanned <= 2 * 10_000, String(windows.scanned));

    const full = new RateWindows(1_000, 60_000, now);
    for (let i = 0; i < 1_000; i++) full.hit(`exhausted-${i}`, [1]);
    full.scanned = 0;
    for (let i = 0; i < 10_000; i++) full.hit(`fresh-${i}`, [1]);
    assert.ok(full.scanned <= 2 * 10_000, String(full.scanned));
    assert.equal(full.size, 1_000);
  });

  it('measures windows on its own clock and reports the time left', () => {
    const { now, advance } = clock();
    const windows = new RateWindows(10, 60_000, now);
    windows.hit('a', [1]);
    advance(20_500);
    assert.equal(windows.hit('a', [1]).remainingMs, 39_500);
    advance(39_500);
    assert.equal(windows.hit('a', [1]).count, 1);
  });

  it('takes its window and limit from the express-rate-limit limiter and stays within capacity', () => {
    const { now, advance } = clock();
    const store = new BoundedRateLimitStore({ capacity: 100, now });
    rateLimit({ windowMs: 30_000, max: 2, store });
    assert.equal(store.windowMs, 30_000);
    assert.equal(store.limit, 2);
    for (let i = 0; i < 1_000; i++) store.increment(`key-${i}`);
    assert.equal(store.size, 100);
    const info = store.increment('key-999');
    assert.equal(info.totalHits, 2);
    assert.ok(info.resetTime && Math.abs(info.resetTime.getTime() - (Date.now() + 30_000)) < 1_000);
    store.decrement('key-999');
    assert.equal(store.get('key-999')?.totalHits, 1);
    store.resetKey('key-999');
    assert.equal(store.get('key-999'), undefined);
    advance(30_000);
    assert.equal(store.get('key-998'), undefined);
    store.resetAll();
    assert.equal(store.size, 0);
    assert.throws(() => new BoundedRateLimitStore().increment('x'), /before init/);
  });
});
