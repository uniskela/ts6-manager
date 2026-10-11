import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { AutomationController } from './automation-controller.js';
import { VoiceBot } from './voice-bot.js';
import type { QueueItem } from './playlist/queue.js';
import { generateIdentity } from './tslib/identity.js';

const auto: QueueItem = { id: 'auto', title: 'Auto-DJ', filePath: '/auto.mp3', source: 'local' };
const human: QueueItem = { id: 'human', title: 'Request', filePath: '/request.mp3', source: 'local' };
const radio: QueueItem = { id: 'radio', title: 'Radio', filePath: '', source: 'radio', streamUrl: 'https://example.com/radio' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(live = false) {
  const bot = new VoiceBot({ id: 1, serverConfigId: 1, name: 'DJ', nickname: 'DJ', serverHost: '127.0.0.1', serverPort: 9987, volume: 50 });
  const runtime = bot as any;
  runtime._status = 'connected';
  runtime.client.sendCommand = () => {};
  runtime.client.sendVoiceStop = () => {};
  runtime.client.sendVoice = () => {};
  runtime.startIcyPolling = () => {};
  runtime.ensurePlayableFile = async (item: QueueItem) => item.filePath;
  const streams: Array<{ stdout: PassThrough; process: EventEmitter; kill(): void; killed: boolean }> = [];
  function stream() {
    const result = { stdout: new PassThrough(), process: new EventEmitter(), killed: false, kill() { result.killed = true; } };
    streams.push(result);
    return result;
  }
  runtime.pipeline.toPcmFileStream = async () => stream();
  runtime.pipeline.toPcmStream = async () => stream();
  const loaded: Array<string | null> = [];
  const source = { load: async () => live ? radio : auto };
  const errors: Error[] = [];
  bot.on('error', error => errors.push(error));
  const controller = new AutomationController({
    settings: { enabled: true, source: { kind: live ? 'radio' : 'playlist', id: 1 }, requireListeners: false,
      quietPeriodSeconds: 300, retryBaseSeconds: 30, retryMaxSeconds: 1800, stayInChannel: false },
    snapshot: () => ({ connected: ['connected', 'playing', 'paused'].includes(bot.status),
      busy: !!bot.mediaSession || !!bot.nowPlaying, hasRequests: bot.queue.upcomingCount > 0, humanListeners: 1 }),
    loadSource: async (_source, last) => { loaded.push(last); return source.load(); },
    play: async (item, current) => {
      if (item.streamUrl) await bot.playStream(item, { automation: current });
      else await bot.play(item, { automation: current });
    },
    stop: () => bot.clearPlayback('channel_empty'),
    persist: async () => {},
    onError: error => errors.push(error as Error),
  });
  bot.automation = controller;
  return { bot, runtime, controller, streams, stream, loaded, source, errors,
    close() { controller.dispose(); bot.clearPlayback('bot_stopped'); } };
}

describe('VoiceBot Auto-DJ integration', () => {
  for (const live of [false, true]) for (const stop of [false, true]) {
    it(`${live ? 'radio' : 'file'} replacement cannot undo a newer ${stop ? 'Stop' : 'play'} during video cleanup`, async t => {
      const f = fixture(); t.after(() => f.close());
      f.controller.dispose();
      const cleanup = deferred<void>();
      f.runtime._videoStreaming = true;
      f.runtime.replaceVideoWithMusic = async () => { await cleanup.promise; return null; };
      const pending = live ? f.bot.playStream(radio) : f.bot.play(human);
      await tick();
      f.runtime._videoStreaming = false;
      if (stop) f.bot.stopAudio();
      else await f.bot.play({ ...human, id: 'newer' });
      cleanup.resolve();
      await pending;
      assert.equal(f.bot.nowPlaying?.id ?? null, stop ? null : 'newer');
      assert.equal(f.streams.length, stop ? 0 : 1);
    });
  }

  it('Previous releases fallback ownership and resumes Auto-DJ when no human history exists', async t => {
    const f = fixture(); t.after(() => f.close());
    await f.controller.reconcile();
    const oldSession = f.bot.musicSessionInfo()!.id;
    f.bot.previous();
    await f.controller.reconcile();
    assert.equal(f.streams[0].killed, true);
    assert.equal(f.streams.length, 2);
    assert.equal(f.bot.nowPlaying?.id, auto.id);
    assert.equal(f.controller.active, true);
    assert.notEqual(f.bot.musicSessionInfo()!.id, oldSession);
  });

  it('a plain request insertion synchronously preempts Auto-DJ and starts the human item', async t => {
    const f = fixture(); t.after(() => f.close());
    await f.controller.reconcile();
    assert.equal(f.bot.nowPlaying?.id, auto.id);
    const old = f.streams[0];
    f.bot.queue.add(human);
    assert.equal(old.killed, true);
    assert.equal(f.controller.active, false);
    await tick();
    assert.equal(f.bot.nowPlaying?.id, human.id);
    assert.equal(f.streams.length, 2);
    assert.equal(f.loaded.length, 1);
  });

  it('does not duplicate the human item when the inserting caller also selects and starts it', async t => {
    const f = fixture(); t.after(() => f.close());
    await f.controller.reconcile();
    f.bot.queue.add(human);
    await f.bot.play(f.bot.queue.next()!);
    await tick();
    assert.equal(f.bot.nowPlaying?.id, human.id);
    assert.equal(f.streams.length, 2);
  });

  it('starts human requests while source loading is pending and discards its later resolution', async t => {
    const f = fixture(); t.after(() => f.close());
    const loading = deferred<QueueItem>();
    f.source.load = () => loading.promise;
    const pending = f.controller.reconcile();
    await tick();
    assert.equal(f.controller.active, false);
    f.bot.queue.add(human);
    await tick();
    assert.equal(f.bot.nowPlaying?.id, human.id);
    loading.resolve(auto);
    await pending;
    assert.equal(f.bot.nowPlaying?.id, human.id);
    assert.equal(f.streams.length, 1);
  });

  it('plain human requests start during Auto-DJ quiet time and source backoff', async t => {
    for (const policy of ['quiet', 'backoff']) {
      const f = fixture(); t.after(() => f.close());
      await f.controller.reconcile();
      if (policy === 'quiet') f.bot.clearPlayback();
      else {
        f.bot.clearPlayback('source_unreachable');
        f.controller.sourceEnded({ failed: true });
      }
      await f.controller.reconcile();
      f.bot.queue.add(human);
      await tick();
      assert.equal(f.bot.nowPlaying?.id, human.id);
      assert.equal(f.loaded.length, 1);
    }
  });

  it('hands back to Auto-DJ after a human queue drains and keeps consumed requests exhausted', async t => {
    const f = fixture(); t.after(() => f.close());
    await f.controller.reconcile();
    f.bot.queue.add(human);
    await tick();
    f.runtime.fileFramesSent = 50;
    f.runtime.finishFileTrack();
    await f.controller.reconcile();
    assert.equal(f.bot.nowPlaying?.id, auto.id);
    assert.equal(f.bot.queue.upcomingCount, 0);
    assert.equal(f.bot.queue.current, null);
    f.runtime.fileFramesSent = 50;
    f.runtime.finishFileTrack();
    await f.controller.reconcile();
    assert.equal(f.bot.nowPlaying?.id, auto.id);
    assert.equal(f.loaded.length, 3);
    assert.equal(f.bot.queue.current, null);
  });

  it('automated finite completion bypasses request repeat-track mode', async t => {
    const f = fixture(); t.after(() => f.close());
    f.bot.queue.setRepeat('track');
    await f.controller.reconcile();
    f.runtime.fileFramesSent = 50;
    f.runtime.finishFileTrack();
    await f.controller.reconcile();
    assert.equal(f.controller.active, true);
    assert.equal(f.loaded.length, 2, 'the automation source selects the next song');
    assert.equal(f.loaded[1], auto.id);
    assert.equal(f.bot.queue.length, 0);
  });

  it('kills a stale live stream opening after the requested song has replaced it', async t => {
    const f = fixture(true); t.after(() => f.close());
    const opening = deferred<ReturnType<typeof f.stream>>();
    f.runtime.pipeline.toPcmStream = () => opening.promise;
    const starting = f.controller.reconcile();
    await tick();
    f.bot.queue.add(human);
    await tick();
    assert.equal(f.bot.nowPlaying?.id, human.id);
    const currentTimer = f.runtime.playbackTimer;
    const stale = f.stream();
    opening.resolve(stale);
    await starting;
    assert.equal(stale.killed, true);
    assert.equal(f.bot.nowPlaying?.id, human.id);
    assert.equal(f.runtime.playbackTimer, currentTimer);
    assert.equal(f.controller.state.failures, 0);
  });

  it('an obsolete live stream opening failure cannot clear newer human playback', async t => {
    const f = fixture(true); t.after(() => f.close());
    const opening = deferred<ReturnType<typeof f.stream>>();
    f.runtime.pipeline.toPcmStream = () => opening.promise;
    const starting = f.controller.reconcile();
    await tick();
    f.bot.queue.add(human);
    await tick();
    const session = f.bot.musicSessionInfo()!.id;
    opening.reject(new Error('old radio failed'));
    await starting;
    assert.equal(f.bot.status, 'playing');
    assert.equal(f.bot.nowPlaying?.id, human.id);
    assert.equal(f.bot.musicSessionInfo()?.id, session);
    assert.equal(f.controller.state.failures, 0);
    assert.deepEqual(f.errors, []);
  });

  it('manual Stop preserves requests and records quiet time before clearing playback', async t => {
    const f = fixture(); t.after(() => f.close());
    await f.controller.reconcile();
    f.bot.queue.add(human);
    await tick();
    f.bot.clearPlayback();
    await f.controller.reconcile();
    assert.equal(f.bot.status, 'connected');
    assert.equal(f.bot.nowPlaying, null);
    assert.equal(f.bot.queue.length, 1);
    assert.ok(f.controller.state.quietUntil > Date.now());
    assert.equal(f.loaded.length, 1);
    await f.bot.play(human);
    assert.equal(f.bot.nowPlaying?.id, human.id, 'human playback is allowed during the quiet period');
  });

  for (const live of [false, true]) for (const method of ['clearPlayback', 'stopAudio'] as const) {
    it(`manual ${method} on automated ${live ? 'radio' : 'file'} retains the manual reason`, async t => {
      const f = fixture(live); t.after(() => f.close());
      await f.controller.reconcile();
      f.bot[method]();
      await f.controller.reconcile();
      assert.equal(f.bot.lastMusicStop?.reason, 'manual');
      assert.equal(f.bot.nowPlaying, null);
      assert.ok(f.controller.state.quietUntil > Date.now());
    });
  }

  it('radio pause and resume retains automation ownership and backoff state', async t => {
    const f = fixture(true); t.after(() => f.close());
    await f.controller.reconcile();
    f.bot.pause();
    assert.equal(f.bot.status, 'paused');
    f.bot.resume();
    await tick();
    assert.equal(f.bot.status, 'playing');
    assert.equal(f.controller.active, true);
    assert.equal(f.bot.nowPlaying?.id, radio.id);
    assert.equal(f.loaded.length, 1);
    assert.equal(f.streams.length, 2);
    assert.equal(f.streams[0].killed, true);
    assert.equal(f.controller.state.failures, 0);
  });

  it('finite source completion without audio backs off instead of looping the playlist', async t => {
    const f = fixture(); t.after(() => f.close());
    await f.controller.reconcile();
    assert.equal(f.runtime.fileFramesSent, 0);
    f.runtime.finishFileTrack();
    await f.controller.reconcile();
    assert.equal(f.bot.status, 'connected');
    assert.equal(f.controller.state.failures, 1);
    assert.equal(f.loaded.length, 1);
  });

  it('initial finite and radio preparation failures record one source failure and stay connected', async t => {
    for (const live of [false, true]) {
      const f = fixture(live); t.after(() => f.close());
      if (live) f.runtime.pipeline.toPcmStream = async () => { throw new Error('cannot open radio'); };
      else f.runtime.ensurePlayableFile = async () => { throw new Error('cannot download song'); };
      await f.controller.reconcile();
      assert.equal(f.bot.status, 'connected');
      assert.equal(f.bot.nowPlaying, null);
      assert.equal(f.controller.active, false);
      assert.equal(f.controller.state.failures, 1);
      assert.equal(f.loaded.length, 1);
    }
  });

  it('a seek preparation failure records one automated failure and returns to connected', async t => {
    const f = fixture(); t.after(() => f.close());
    await f.controller.reconcile();
    f.runtime.pipeline.toPcmFileStream = async () => { throw new Error('expired source'); };
    await assert.rejects(f.bot.seek(30), /expired source/);
    await f.controller.reconcile();
    assert.equal(f.bot.status, 'connected');
    assert.equal(f.bot.nowPlaying, null);
    assert.equal(f.controller.state.failures, 1);
    assert.equal(f.loaded.length, 1);
  });

  it('rejects duplicate pending starts and ignores connection completion after Stop or disconnect', async t => {
    for (const cancellation of ['stop', 'disconnect']) {
      const f = fixture(); t.after(() => f.close());
      f.runtime._status = 'stopped';
      f.runtime.config.identity = generateIdentity(0);
      f.runtime.applyAvatar = async () => {};
      const connecting = deferred<void>();
      let connections = 0;
      let connectedEvents = 0;
      f.bot.on('connected', () => { connectedEvents++; });
      f.runtime.client.connect = () => { connections++; return connecting.promise; };
      f.runtime.client.disconnect = () => f.runtime.client.emit('disconnected');
      const start = f.bot.start();
      await assert.rejects(f.bot.start(), /already running/);
      assert.equal(connections, 1);
      if (cancellation === 'stop') await f.bot.stop();
      else f.runtime.client.emit('disconnected');
      connecting.resolve();
      await start;
      assert.equal(f.bot.status, 'stopped');
      assert.equal(connectedEvents, 0);
      assert.equal(f.loaded.length, 0);
    }
  });

  it('a short radio process close marks the fallback failed and backs off without looping', async t => {
    const f = fixture(true); t.after(() => f.close());
    await f.controller.reconcile();
    f.streams[0].process.emit('close', 0);
    await f.controller.reconcile();
    assert.equal(f.bot.status, 'connected');
    assert.equal(f.bot.nowPlaying, null);
    assert.equal(f.controller.state.failures, 1);
    assert.ok(f.controller.state.retryUntil > Date.now());
    assert.equal(f.loaded.length, 1);
  });

  it('a running decoder error returns to connected and records one automated failure', async t => {
    const f = fixture(true); t.after(() => f.close());
    await f.controller.reconcile();
    f.streams[0].process.emit('error', new Error('decoder failed'));
    await f.controller.reconcile();
    assert.equal(f.bot.status, 'connected');
    assert.equal(f.bot.nowPlaying, null);
    assert.equal(f.controller.state.failures, 1);
    assert.equal(f.loaded.length, 1);
  });
});
