import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Lightweight unit test of the enqueue serialization pattern used by WebQueryClient.
 * (Avoids spinning a real TS WebQuery server.)
 */
describe('WebQuery request queue pattern', () => {
  it('runs enqueued ops strictly one at a time', async () => {
    let chain: Promise<void> = Promise.resolve();
    const enqueue = <T,>(op: () => Promise<T>): Promise<T> => {
      const run = chain.then(op, op);
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    const order: number[] = [];
    const started: number[] = [];

    const mk = (id: number, delay: number) =>
      enqueue(async () => {
        started.push(id);
        await new Promise((r) => setTimeout(r, delay));
        order.push(id);
        return id;
      });

    const results = await Promise.all([mk(1, 30), mk(2, 5), mk(3, 5)]);
    assert.deepEqual(results, [1, 2, 3]);
    // Second/third must not start until prior finished → start order == completion order
    assert.deepEqual(started, [1, 2, 3]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('keeps the chain alive after a failed op', async () => {
    let chain: Promise<void> = Promise.resolve();
    const enqueue = <T,>(op: () => Promise<T>): Promise<T> => {
      const run = chain.then(op, op);
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    await assert.rejects(() => enqueue(async () => {
      throw new Error('boom');
    }));

    const ok = await enqueue(async () => 'recovered');
    assert.equal(ok, 'recovered');
  });
});
