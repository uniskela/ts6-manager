import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlayQueue, type QueueItem } from './playlist/queue.js';
import { createQueueChangeHook } from './queue-change-hook.js';

const song = (id: string): QueueItem => ({ id, title: id, filePath: `/music/${id}.mp3`, source: 'local' });
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options: { enabled?: boolean; status?: string; video?: boolean; playing?: boolean } = {}) {
  const state = { status: options.status ?? 'connected', video: options.video ?? false, nowPlaying: options.playing ? song('current') : null as QueueItem | null };
  const plays: QueueItem[] = [];
  const errors: unknown[] = [];
  const calls = { requestQueued: 0, reconcile: 0 };
  const automation = {
    configuration: { enabled: options.enabled ?? true },
    requestQueued() { calls.requestQueued++; },
    reconcile: async () => { calls.reconcile++; },
  };
  let failPlay = false;
  const queue: PlayQueue = new PlayQueue(createQueueChangeHook({
    automation: () => automation,
    isConnected: () => state.status === 'connected',
    nowPlaying: () => state.nowPlaying,
    hasVideoSession: () => state.video,
    next: () => queue.next(),
    play: async item => {
      plays.push(item);
      if (failPlay) throw new Error('boom');
      state.nowPlaying = item;
    },
    emitError: err => errors.push(err),
  }));
  return { state, plays, errors, calls, queue, failNextPlay: () => { failPlay = true; } };
}

describe('queue change hook', () => {
  it('starts the next item once for a plain add on an idle connected bot with automation enabled', async () => {
    const h = harness();
    h.queue.add(song('a'));
    await tick();
    assert.deepEqual(h.plays.map(item => item.id), ['a']);
    assert.equal(h.calls.requestQueued, 1);
    assert.equal(h.calls.reconcile, 1);
  });

  it('does not start when automation is disabled, but still reconciles', async () => {
    const h = harness({ enabled: false });
    h.queue.add(song('a'));
    await tick();
    assert.equal(h.plays.length, 0);
    assert.equal(h.calls.reconcile, 1);
  });

  it('does not double-start when the caller starts its own item through addForPlayback', async () => {
    const h = harness();
    const item = song('a');
    h.queue.addForPlayback(item);
    // The caller starts its own item synchronously, before the deferred hook runs.
    h.state.nowPlaying = item;
    await tick();
    assert.equal(h.plays.length, 0);
    assert.equal(h.queue.current, item);
  });

  it('starts nothing while a video session is active, while playing, or while not connected', async () => {
    for (const options of [{ video: true }, { playing: true }, { status: 'paused' }, { status: 'disconnected' }]) {
      const h = harness(options);
      h.queue.add(song('a'));
      await tick();
      assert.equal(h.plays.length, 0, JSON.stringify(options));
    }
  });

  it('reports a failed start through the error emitter instead of throwing', async () => {
    const h = harness();
    h.failNextPlay();
    h.queue.add(song('a'));
    await tick();
    assert.equal(h.errors.length, 1);
  });
});
