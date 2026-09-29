import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  takeTrackedIfReadyOrCancel,
  takeTrackedWithGraceOrCancel,
  trackPromise,
} from './metrics-race.js';

describe('trackPromise / takeTrackedIfReadyOrCancel', () => {
  it('returns metrics when already settled before the peek', async () => {
    const tracked = trackPromise(Promise.resolve({ status: 'current' as const }));
    await tracked.promise;
    let cancelled = false;
    const result = takeTrackedIfReadyOrCancel(
      tracked,
      () => { cancelled = true; },
      { status: 'timeout' as const },
    );
    assert.deepEqual(result, { status: 'current' });
    assert.equal(cancelled, false);
  });

  it('cancels and returns fallback when metrics are still pending', async () => {
    let cancelled = false;
    let resolveMetrics!: (value: { status: string }) => void;
    const tracked = trackPromise(new Promise<{ status: string }>((resolve) => {
      resolveMetrics = resolve;
    }));

    assert.equal(tracked.isSettled(), false);
    const result = takeTrackedIfReadyOrCancel(
      tracked,
      () => { cancelled = true; },
      { status: 'timeout' },
    );
    assert.deepEqual(result, { status: 'timeout' });
    assert.equal(cancelled, true);

    // Late settle must not throw unhandled.
    resolveMetrics({ status: 'current' });
    await tracked.promise;
  });
});

describe('takeTrackedWithGraceOrCancel', () => {
  it('returns metrics that settle during the grace window', async () => {
    let cancelled = false;
    let resolveMetrics!: (value: { status: string }) => void;
    const tracked = trackPromise(new Promise<{ status: string }>((resolve) => {
      resolveMetrics = resolve;
    }));

    const pending = takeTrackedWithGraceOrCancel(
      tracked,
      () => { cancelled = true; },
      { status: 'timeout' },
      200,
    );
    setTimeout(() => resolveMetrics({ status: 'current' }), 40);
    const result = await pending;
    assert.deepEqual(result, { status: 'current' });
    assert.equal(cancelled, false);
  });

  it('cancels after grace when metrics stay pending', async () => {
    let cancelled = false;
    const tracked = trackPromise(new Promise<{ status: string }>(() => {
      /* never settles */
    }));

    const started = Date.now();
    const result = await takeTrackedWithGraceOrCancel(
      tracked,
      () => { cancelled = true; },
      { status: 'timeout' },
      80,
    );
    assert.deepEqual(result, { status: 'timeout' });
    assert.equal(cancelled, true);
    assert.ok(Date.now() - started >= 70);
  });
});
