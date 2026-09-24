import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { takeTrackedIfReadyOrCancel, trackPromise } from './metrics-race.js';

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
