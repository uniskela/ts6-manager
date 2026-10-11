import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BotAutomationSettings } from '@ts6/common';
import { AutomationController, type AutomationClock, type AutomationRuntimeState, type AutomationSnapshot } from './automation-controller.js';
import type { QueueItem } from './playlist/queue.js';

const settings: BotAutomationSettings = {
  enabled: true, source: { kind: 'playlist', id: 1 }, requireListeners: false,
  quietPeriodSeconds: 300, retryBaseSeconds: 30, retryMaxSeconds: 120, stayInChannel: false,
};
const song: QueueItem = { id: 'song-1', title: 'First', filePath: '/music/first.mp3', source: 'local' };

class Clock implements AutomationClock {
  time = 1_000_000;
  tasks = new Map<number, { callback: () => void; at: number }>();
  private sequence = 0;
  now = () => this.time;
  setTimer(callback: () => void, delayMs: number) {
    const id = ++this.sequence;
    this.tasks.set(id, { callback, at: this.time + delayMs });
    return () => { this.tasks.delete(id); };
  }
  advance(ms: number) {
    this.time += ms;
    for (const [id, task] of this.tasks) {
      if (task.at <= this.time) { this.tasks.delete(id); task.callback(); }
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<BotAutomationSettings> = {}, state?: Partial<AutomationRuntimeState>) {
  const clock = new Clock();
  const snapshot: AutomationSnapshot = { connected: true, busy: false, hasRequests: false, humanListeners: 1 };
  const saves: AutomationRuntimeState[] = [];
  const played: string[] = [];
  let stops = 0;
  let loads = 0;
  const errors: unknown[] = [];
  const callbacks = {
    load: async (_source: NonNullable<BotAutomationSettings['source']>, _last: string | null) => song,
    play: async (item: QueueItem, current: () => boolean) => {
      if (current()) { played.push(item.id); snapshot.busy = true; }
    },
    stop: () => { snapshot.busy = false; },
  };
  const controller = new AutomationController({
    settings: { ...settings, ...overrides }, state, clock,
    snapshot: () => snapshot,
    loadSource: (source, last) => { loads++; return callbacks.load(source, last); },
    play: (item, current) => callbacks.play(item, current),
    stop: () => { stops++; callbacks.stop(); },
    persist: async value => { saves.push(value); },
    onError: error => errors.push(error),
  });
  return { controller, clock, snapshot, callbacks, saves, played, errors, get stops() { return stops; }, get loads() { return loads; } };
}

describe('AutomationController', () => {
  it('coalesces concurrent connection/queue/listener notifications into one fallback start', async () => {
    const f = fixture();
    const a = f.controller.reconcile();
    assert.equal(f.controller.reconcile(), a);
    await Promise.all(Array.from({ length: 10 }, () => f.controller.reconcile()));
    assert.equal(f.loads, 1);
    assert.deepEqual(f.played, [song.id]);
    assert.equal(f.controller.active, true);
    await f.controller.flush();
    assert.equal(f.saves.at(-1)?.lastTrackId, song.id);
    f.controller.dispose();
  });

  it('never loads fallback while requests, human playback, disconnection, or listener policy block it', async () => {
    for (const blocker of [
      { hasRequests: true }, { busy: true }, { connected: false }, { humanListeners: 0 },
    ]) {
      const f = fixture({ requireListeners: true });
      Object.assign(f.snapshot, blocker);
      await f.controller.reconcile();
      assert.equal(f.loads, 0);
      f.controller.dispose();
    }
  });

  it('preempts owned fallback synchronously and leaves human playback untouched', async () => {
    const f = fixture();
    await f.controller.reconcile();
    f.snapshot.hasRequests = true;
    f.controller.requestQueued();
    assert.equal(f.stops, 1);
    assert.equal(f.controller.active, false);
    f.snapshot.busy = true;
    f.controller.requestQueued();
    await f.controller.reconcile();
    assert.equal(f.stops, 1);
    assert.equal(f.loads, 1);
    f.controller.dispose();
  });

  it('drops a stale source resolution after a human request arrives, then resumes after requests finish', async () => {
    const f = fixture();
    const loading = deferred<QueueItem>();
    f.callbacks.load = () => loading.promise;
    const running = f.controller.reconcile();
    await Promise.resolve();
    f.snapshot.hasRequests = true;
    f.controller.requestQueued();
    loading.resolve(song);
    await running;
    assert.deepEqual(f.played, []);
    f.snapshot.hasRequests = false;
    f.callbacks.load = async () => song;
    await f.controller.reconcile();
    assert.deepEqual(f.played, [song.id]);
    f.controller.dispose();
  });

  it('guards asynchronous playback preparation after manual Stop', async () => {
    const f = fixture();
    const preparing = deferred<void>();
    let entered = false;
    f.callbacks.play = async (item, current) => {
      entered = true;
      await preparing.promise;
      if (current()) f.played.push(item.id);
    };
    const running = f.controller.reconcile();
    while (!entered) await Promise.resolve();
    f.controller.manualStop();
    preparing.resolve();
    await running;
    assert.deepEqual(f.played, []);
    assert.equal(f.stops, 1);
    assert.equal(f.controller.state.quietUntil, f.clock.now() + 300_000);
    f.controller.dispose();
  });

  it('sets quiet time before synchronous stop notifications and wakes exactly at the deadline', async () => {
    const f = fixture();
    await f.controller.reconcile();
    f.callbacks.stop = () => {
      assert.equal(f.controller.state.quietUntil, f.clock.now() + 300_000);
      f.snapshot.busy = false;
      f.controller.sourceEnded();
      void f.controller.reconcile();
    };
    f.controller.manualStop();
    await f.controller.reconcile();
    f.clock.advance(299_999);
    await f.controller.reconcile();
    assert.equal(f.loads, 1);
    f.clock.advance(1);
    await f.controller.reconcile();
    assert.equal(f.loads, 2);
    f.controller.dispose();
  });

  it('restores manual Stop quiet state across a process restart without blocking human requests', async () => {
    const before = fixture();
    before.controller.manualStop();
    await before.controller.flush();
    const persisted = before.saves.at(-1)!;
    before.controller.dispose();
    const after = fixture({}, persisted);
    await after.controller.reconcile();
    assert.equal(after.loads, 0);
    after.snapshot.hasRequests = true;
    after.controller.requestQueued();
    await after.controller.reconcile();
    assert.equal(after.stops, 0);
    after.snapshot.hasRequests = false;
    after.clock.advance(300_000);
    await after.controller.reconcile();
    assert.equal(after.loads, 1);
    after.controller.dispose();
  });

  it('invalidates an old connection source resolution and starts only once after reconnect', async () => {
    const f = fixture();
    const loading = deferred<QueueItem>();
    f.callbacks.load = () => loading.promise;
    const running = f.controller.reconcile();
    await Promise.resolve();
    f.snapshot.connected = false;
    f.controller.disconnected();
    f.snapshot.connected = true;
    f.callbacks.load = async () => song;
    void f.controller.reconcile();
    loading.resolve({ ...song, id: 'old-connection' });
    await running;
    assert.deepEqual(f.played, [song.id]);
    assert.equal(f.loads, 2);
    f.controller.dispose();
  });

  it('ignores errors from canceled work without penalizing the current source', async () => {
    const f = fixture();
    const loading = deferred<QueueItem>();
    f.callbacks.load = () => loading.promise;
    const running = f.controller.reconcile();
    await Promise.resolve();
    f.controller.manualStop();
    loading.reject(new Error('obsolete failure'));
    await running;
    assert.equal(f.controller.state.failures, 0);
    assert.deepEqual(f.errors, []);
    f.controller.dispose();
  });

  it('backs off broken sources exponentially, caps retries, and preserves the deadline on restart', async () => {
    const f = fixture();
    f.callbacks.load = async () => { throw new Error('broken source'); };
    for (const delay of [30_000, 60_000, 120_000, 120_000]) {
      await f.controller.reconcile();
      assert.equal(f.controller.state.retryUntil, f.clock.now() + delay);
      await f.controller.flush();
      const restarted = fixture({}, f.saves.at(-1));
      restarted.clock.time = f.clock.time;
      await restarted.controller.reconcile();
      assert.equal(restarted.loads, 0);
      restarted.controller.dispose();
      f.clock.advance(delay);
    }
    f.controller.dispose();
  });

  it('does not reset failures merely because a radio stream started successfully', async () => {
    const f = fixture({ source: { kind: 'radio', id: 2 } });
    for (const failure of [1, 2, 3]) {
      await f.controller.reconcile();
      f.clock.advance(5_000);
      f.snapshot.busy = false;
      f.controller.sourceEnded();
      await f.controller.reconcile();
      assert.equal(f.controller.state.failures, failure);
      f.clock.advance(Math.min(30_000 * 2 ** (failure - 1), 120_000));
    }
    f.controller.dispose();
  });

  it('resets backoff only after a healthy radio interval or successful finite completion', async () => {
    const radio = fixture({ source: { kind: 'radio', id: 2 } }, { failures: 3 });
    await radio.controller.reconcile();
    assert.equal(radio.controller.state.failures, 3);
    radio.clock.advance(30_000);
    await radio.controller.reconcile();
    assert.equal(radio.controller.state.failures, 0);
    radio.controller.dispose();
    const finite = fixture({}, { failures: 3 });
    await finite.controller.reconcile();
    finite.snapshot.busy = false;
    finite.controller.sourceEnded();
    assert.equal(finite.controller.state.failures, 0);
    await finite.controller.reconcile();
    assert.equal(finite.loads, 2);
    finite.controller.dispose();
  });

  it('retains playlist position across restart while letting an existing human player finish', async () => {
    const f = fixture({}, { lastTrackId: 'song-8' });
    f.snapshot.busy = true;
    await f.controller.reconcile();
    assert.equal(f.loads, 0);
    f.callbacks.load = async (_source, last) => {
      assert.equal(last, 'song-8');
      return song;
    };
    f.snapshot.busy = false;
    await f.controller.reconcile();
    assert.equal(f.loads, 1);
    f.controller.dispose();
  });

  it('stops only owned playback when listeners leave or Auto-DJ is disabled', async () => {
    const f = fixture({ requireListeners: true });
    await f.controller.reconcile();
    f.snapshot.humanListeners = 0;
    await f.controller.reconcile();
    assert.equal(f.stops, 1);
    f.snapshot.humanListeners = 1;
    await f.controller.reconcile();
    f.controller.configure({ ...settings, enabled: false });
    await f.controller.reconcile();
    assert.equal(f.stops, 2);
    assert.equal(f.loads, 2);
    f.controller.dispose();
  });

  it('preserves active playback ownership when changing a policy that still allows playback', async () => {
    const f = fixture();
    await f.controller.reconcile();
    f.controller.configure({ ...settings, stayInChannel: true, quietPeriodSeconds: 600 });
    await f.controller.reconcile();
    assert.equal(f.controller.active, true);
    assert.equal(f.stops, 0);
    assert.equal(f.loads, 1);
    f.controller.dispose();
  });

  it('invalidates old source work and resets source-specific retries when settings change', async () => {
    const f = fixture({}, { failures: 2, lastTrackId: 'old-track' });
    const loading = deferred<QueueItem>();
    f.callbacks.load = () => loading.promise;
    const running = f.controller.reconcile();
    await Promise.resolve();
    f.callbacks.load = async (source, last) => {
      assert.deepEqual(source, { kind: 'radio', id: 22 });
      assert.equal(last, null);
      return { ...song, id: 'new-source' };
    };
    f.controller.configure({ ...settings, source: { kind: 'radio', id: 22 } });
    loading.resolve(song);
    await running;
    assert.deepEqual(f.played, ['new-source']);
    assert.equal(f.controller.state.failures, 0);
    f.controller.dispose();
  });

  it('persists explicit Home/Leave suppression and remembered 24/7 channel until a manual join', async () => {
    const f = fixture({ stayInChannel: true });
    f.controller.rememberChannel(42);
    f.controller.rememberChannel(-1);
    f.controller.suspendPresence();
    await f.controller.flush();
    assert.equal(f.controller.keepChannel, false);
    assert.equal(f.controller.state.channelId, 42);
    const restart = fixture({ stayInChannel: true }, f.saves.at(-1));
    await restart.controller.reconcile();
    assert.equal(restart.loads, 0);
    assert.equal(restart.controller.keepChannel, false);
    restart.controller.resumePresence();
    await restart.controller.reconcile();
    assert.equal(restart.controller.keepChannel, true);
    assert.equal(restart.loads, 1);
    f.controller.dispose();
    restart.controller.dispose();
  });

  it('disposal cancels timers and pending work without starting another stream', async () => {
    const f = fixture();
    const loading = deferred<QueueItem>();
    f.callbacks.load = () => loading.promise;
    const running = f.controller.reconcile();
    await Promise.resolve();
    f.controller.dispose();
    loading.resolve(song);
    await running;
    assert.deepEqual(f.played, []);
    assert.equal(f.clock.tasks.size, 0);
    await f.controller.reconcile();
    assert.equal(f.loads, 1);
  });
});
