import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInOrderWithin } from './ordered-shutdown.js';

describe('runInOrderWithin', () => {
  it('runs steps in order and reports completion', async () => {
    const order: string[] = [];
    const done = await runInOrderWithin([async () => { order.push('flush'); }, async () => { order.push('disconnect'); }], 1_000);
    assert.equal(done, true);
    assert.deepEqual(order, ['flush', 'disconnect']);
  });

  it('gives up at the deadline without starting the next step under a running one', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    // The helper's deadline timer is unreferenced (it must not keep a backend alive); keep the test's loop alive.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      const done = await runInOrderWithin([
        async () => { order.push('flush started'); await slow; order.push('flush finished'); },
        async () => { order.push('disconnect'); },
      ], 20);
      assert.equal(done, false);
      assert.deepEqual(order, ['flush started'], 'the disconnect did not start while the flush was running');
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, ['flush started', 'flush finished', 'disconnect']);
    } finally {
      clearInterval(keepAlive);
    }
  });
});
