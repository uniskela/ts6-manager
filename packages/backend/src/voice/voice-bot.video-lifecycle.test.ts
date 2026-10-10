import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { VoiceBot } from './voice-bot.js';
import { StreamSignaling } from './streaming/stream-signaling.js';

function makeBot(): VoiceBot {
  return new VoiceBot({
    id: 7,
    serverConfigId: 1,
    name: 'test',
    serverHost: '127.0.0.1',
    serverPort: 9987,
    nickname: 'Bot',
    volume: 50,
  });
}

/** Put the bot in a "streaming" state without a TeamSpeak server or sidecar. */
function fakeStreaming(bot: VoiceBot, timeoutSec: number) {
  const b = bot as any;
  const sidecarCalls: string[] = [];
  b._videoStreaming = true;
  b._activeStreamId = 'stream-1';
  b._videoStartedAt = Date.now();
  b._noViewerTimeoutSec = timeoutSec;
  b.sidecarHttp = {
    stopSource: async () => { sidecarCalls.push('stopSource'); },
    closePeer: async (id: string) => { sidecarCalls.push(`closePeer:${id}`); },
  };
  b.signaling = {
    sendRemoveClient: () => {},
    sendStreamStop: () => { sidecarCalls.push('stopstream'); },
    dispose: () => { sidecarCalls.push('dispose'); },
  };
  // Keep existing lifecycle tests isolated from chat transport; notice tests
  // replace this with a spy and verify the public sendChannelMessage path.
  b.sendChannelMessage = () => {};
  return { b, sidecarCalls };
}

describe('video no-viewer auto-stop', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('makes a concurrent stop wait for the one already running', async () => {
    const bot = makeBot();
    const { sidecarCalls } = fakeStreaming(bot, 0);
    const first = bot.stopVideoStream('manual', 'first');
    const second = bot.stopVideoStream('replaced_by_music', 'second');
    assert.equal(first, second, 'both callers share one stop');
    let secondDone = false;
    void second.then(() => { secondDone = true; });
    await Promise.resolve();
    assert.equal(secondDone, false, 'the second caller does not return while the stream is still up');

    mock.timers.tick(1_000);
    await first;
    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.videoStreamStatus.lastStop?.detail, 'first');
    assert.equal(sidecarCalls.filter((c) => c === 'stopstream').length, 1);
  });

  it('counts down with no viewers and records a truthful stop reason', async () => {
    const bot = makeBot();
    const { b, sidecarCalls } = fakeStreaming(bot, 300);

    b.refreshNoViewerTimer();
    assert.equal(bot.videoStreamStatus.noViewer.timeoutSec, 300);
    assert.equal(bot.videoStreamStatus.noViewer.stopAt, 1_000_000 + 300_000);

    mock.timers.tick(299_000);
    assert.equal(bot.videoStreaming, true);

    mock.timers.tick(1_000);
    // stopVideoStream waits 1s for stopstream to flush.
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(bot.videoStreaming, false);
    const status = bot.videoStreamStatus;
    assert.equal(status.noViewer.stopAt, null);
    assert.equal(status.lastStop?.reason, 'no_viewers');
    assert.equal(status.lastStop?.detail, 'Stopped after 5 minutes with no viewers');
    assert.ok(sidecarCalls.includes('stopSource'));
    assert.ok(sidecarCalls.includes('stopstream'));
    assert.ok(sidecarCalls.includes('dispose'), 'stopping detaches stream signaling from the client');
  });

  it('cancels the countdown when a viewer joins and restarts it when they leave', () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 60);

    b.refreshNoViewerTimer();
    assert.notEqual(bot.videoStreamStatus.noViewer.stopAt, null);

    b._viewers.set(42, { clid: 42, joinedAt: Date.now(), iceState: 'new' });
    b.refreshNoViewerTimer();
    assert.equal(bot.videoStreamStatus.noViewer.stopAt, null);

    mock.timers.tick(120_000);
    assert.equal(bot.videoStreaming, true, 'a watched stream must not stop');

    b._viewers.delete(42);
    b.refreshNoViewerTimer();
    assert.equal(bot.videoStreamStatus.noViewer.stopAt, Date.now() + 60_000);
  });

  it('does not count down when the timeout is off', () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    b.refreshNoViewerTimer();
    assert.equal(bot.videoStreamStatus.noViewer.stopAt, null);
    mock.timers.tick(10 * 60_000);
    assert.equal(bot.videoStreaming, true);
  });

  it('warns 60 s before a no-viewer stop and then posts the stop notice', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 300);
    const messages: string[] = [];
    let directSends = 0;
    b.sendChannelMessage = (message: string) => messages.push(message);
    b.client.sendCommand = (command: string) => {
      if (command.startsWith('sendtextmessage')) directSends++;
    };

    b.refreshNoViewerTimer();
    mock.timers.tick(239_000);
    assert.deepEqual(messages, []);
    mock.timers.tick(1_000);
    assert.deepEqual(messages, ['Nobody is watching. The stream stops in 1 minute.']);

    mock.timers.tick(60_000);
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(messages, [
      'Nobody is watching. The stream stops in 1 minute.',
      'Stopped the stream: nobody watched for 5 minutes.',
    ]);
    assert.equal(directSends, 0, 'notices use sendChannelMessage rather than the client directly');
  });

  it('viewer joining after the warning cancels the stop and sends nothing more', () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 300);
    const messages: string[] = [];
    b.sendChannelMessage = (message: string) => messages.push(message);

    b.refreshNoViewerTimer();
    mock.timers.tick(240_000);
    assert.deepEqual(messages, ['Nobody is watching. The stream stops in 1 minute.']);

    b._viewers.set(42, { clid: 42, joinedAt: Date.now(), iceState: 'connected' });
    b.refreshNoViewerTimer();
    mock.timers.tick(60_000);

    assert.equal(bot.videoStreaming, true);
    assert.deepEqual(messages, ['Nobody is watching. The stream stops in 1 minute.']);
  });

  it('does not announce another auto-stop while a no-viewer stop is flushing', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 300);
    const messages: string[] = [];
    b.sendChannelMessage = (message: string) => messages.push(message);
    b.config.autoStopEmptySeconds = 1;
    b.client.getChannelUserCount = () => 0;

    b.refreshNoViewerTimer();
    mock.timers.tick(299_000);
    b.startAutoStopTimer();
    b.autoStopEmptySince = Date.now() - 5_000;
    mock.timers.tick(1_000);
    const stop = b._videoStopPromise;
    // Keep the original stop in its cleanup while the channel timer fires.
    await Promise.resolve();
    mock.timers.tick(4_000);
    assert.deepEqual(messages, [
      'Nobody is watching. The stream stops in 1 minute.',
      'Stopped the stream: nobody watched for 5 minutes.',
    ]);
    await Promise.resolve();
    mock.timers.tick(1_000);
    await stop;
    assert.equal(bot.videoStreaming, false);
  });

  it('cannot rearm no-viewer notices while a stream is stopping', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 300);
    let releaseSource!: () => void;
    b.sidecarHttp.stopSource = () => new Promise<void>((resolve) => { releaseSource = resolve; });
    const stop = bot.stopVideoStream('manual');
    try {
      // Viewer removal can refresh the countdown while sidecar shutdown awaits.
      b.refreshNoViewerTimer();
      assert.equal(bot.videoStreamStatus.noViewer.stopAt, null);
      assert.equal(b._noViewerTimer, null);
      assert.equal(b._noViewerWarnTimer, null);
    } finally {
      releaseSource();
      await Promise.resolve();
      await Promise.resolve();
      mock.timers.tick(1_000);
      await stop;
    }
  });

  for (const timeoutSec of [45, 60]) it(`does not send a warning at a ${timeoutSec}-second timeout`, async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, timeoutSec);
    const messages: string[] = [];
    b.sendChannelMessage = (message: string) => messages.push(message);

    b.refreshNoViewerTimer();
    mock.timers.tick(timeoutSec * 1_000);
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(bot.videoStreaming, false);
    assert.deepEqual(messages, [timeoutSec === 60
      ? 'Stopped the stream: nobody watched for 1 minute.'
      : 'Stopped the stream: nobody watched for 45 seconds.']);
  });

  it('sends nothing when auto-stop announcements are switched off', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 300);
    const messages: string[] = [];
    b._videoSettings = { ...b._videoSettings, announceAutoStops: false };
    b.sendChannelMessage = (message: string) => messages.push(message);

    b.refreshNoViewerTimer();
    mock.timers.tick(300_000);
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(bot.videoStreaming, false);
    assert.deepEqual(messages, []);
  });

  async function runChannelEmptyStop(media: 'music' | 'radio', announceAutoStops = true, floodHold = false): Promise<string[]> {
    const bot = makeBot();
    const b = bot as any;
    const messages: string[] = [];
    b._status = 'playing';
    b._isStreaming = media === 'radio';
    b.config.autoStopEmptySeconds = 1;
    b.config.loadVideoSettings = async () => ({ ...b._videoSettings, announceAutoStops });
    b.client.getChannelUserCount = () => 0;
    b.client.sendVoiceStop = () => {};
    let directSends = 0;
    b.client.sendCommand = (command: string) => {
      if (command.startsWith('sendtextmessage')) directSends++;
    };
    b.sendChannelMessage = (message: string) => {
      messages.push(message);
      if (floodHold) VoiceBot.prototype.sendChannelMessage.call(bot, message);
    };
    if (floodHold) b.client.emit('ts3error', { id: '524', msg: 'client is flooding' });
    b.startAutoStopTimer();

    mock.timers.tick(5_000);
    mock.timers.tick(5_000);
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(10_000);
    assert.equal(bot.status, 'connected');
    assert.equal(directSends, 0, 'announcements never bypass sendChannelMessage');
    return messages;
  }

  it('channel-empty radio stop sends the radio notice once', async () => {
    assert.deepEqual(await runChannelEmptyStop('radio'), [
      'Stopped radio: the channel was empty for 1 second.',
    ]);
  });

  it('channel-empty music stop sends the music notice once', async () => {
    assert.deepEqual(await runChannelEmptyStop('music'), [
      'Stopped the music: the channel was empty for 1 second.',
    ]);
  });

  it('a pending settings load cannot clear replacement music', async () => {
    const bot = makeBot();
    const b = bot as any;
    let releaseSettings!: () => void;
    const ready = new Promise<void>((resolve) => { releaseSettings = resolve; });
    b._status = 'playing';
    b.config.loadVideoSettings = async () => {
      await ready;
      return { ...b._videoSettings, announceAutoStops: false };
    };
    b.client.sendCommand = () => {};
    b.client.sendVoiceStop = () => {};
    b.sendChannelMessage = () => assert.fail('announcements are switched off');

    const stop = b.handleChannelEmptyAutoStop(300);
    assert.equal(bot.status, 'connected', 'the expired playback stops immediately');
    b._status = 'playing'; // New music starts while notice settings are loading.
    releaseSettings();
    await stop;
    assert.equal(bot.status, 'playing', 'the replacement remains active');
  });

  for (const change of ['moves to another channel', 'disconnects'] as const) {
    it(`sends no channel-empty notice when the bot ${change} while settings load`, async () => {
      const bot = makeBot();
      const b = bot as any;
      let releaseSettings!: () => void;
      const ready = new Promise<void>((resolve) => { releaseSettings = resolve; });
      let channelId = 5;
      b._status = 'playing';
      b.client.getCurrentChannelId = () => channelId;
      b.config.loadVideoSettings = async () => {
        await ready;
        return { ...b._videoSettings, announceAutoStops: true };
      };
      b.client.sendCommand = () => {};
      b.client.sendVoiceStop = () => {};
      const messages: string[] = [];
      b.sendChannelMessage = (message: string) => messages.push(message);

      const stop = b.handleChannelEmptyAutoStop(300);
      if (change === 'moves to another channel') channelId = 9;
      else b._status = 'stopped';
      releaseSettings();
      await stop;
      assert.deepEqual(messages, [], 'the old channel\'s notice is not posted elsewhere');
    });
  }

  for (const media of ['music', 'radio'] as const) {
    it(`sends nothing for a channel-empty ${media} stop when announcements are off`, async () => {
      assert.deepEqual(await runChannelEmptyStop(media, false), []);
    });

    it(`channel-empty ${media} notice respects an active 524 flood hold`, async () => {
      assert.deepEqual(await runChannelEmptyStop(media, true, true), [
        media === 'radio'
          ? 'Stopped radio: the channel was empty for 1 second.'
          : 'Stopped the music: the channel was empty for 1 second.',
      ]);
    });
  }

  it('video warning and stop notice go through sendChannelMessage during a 524 flood hold', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 300);
    const messages: string[] = [];
    const sent: string[] = [];
    b.client.sendCommand = (command: string) => sent.push(command);
    b.sendChannelMessage = (message: string) => {
      messages.push(message);
      VoiceBot.prototype.sendChannelMessage.call(bot, message);
    };
    b.refreshNoViewerTimer();
    mock.timers.tick(239_000);
    b.client.emit('ts3error', { id: '524', msg: 'client is flooding' });
    mock.timers.tick(1_000);
    assert.equal(bot.floodHoldActive, true);
    assert.deepEqual(messages, ['Nobody is watching. The stream stops in 1 minute.']);
    assert.deepEqual(sent, []);

    mock.timers.tick(59_000);
    b.client.emit('ts3error', { id: '524', msg: 'client is flooding' });
    mock.timers.tick(1_000);
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.floodHoldActive, true);
    assert.deepEqual(messages, [
      'Nobody is watching. The stream stops in 1 minute.',
      'Stopped the stream: nobody watched for 5 minutes.',
    ]);
    assert.deepEqual(sent, [], 'neither notice bypasses the flood hold');
  });

  for (const announceAutoStops of [true, false]) {
    it(`channel-empty video stop honors announcements=${announceAutoStops}`, async () => {
      const bot = makeBot();
      const { b } = fakeStreaming(bot, 0);
      const messages: string[] = [];
      b._videoSettings = { ...b._videoSettings, announceAutoStops };
      b.sendChannelMessage = (message: string) => messages.push(message);
      const stop = b.handleChannelEmptyAutoStop(300);
      await Promise.resolve();
      await Promise.resolve();
      mock.timers.tick(1_000);
      await stop;
      assert.equal(bot.videoStreaming, false);
      assert.deepEqual(messages, announceAutoStops
        ? ['Stopped the stream: the channel was empty for 5 minutes.']
        : []);
    });
  }

  it('records manual stops and ignores a concurrent second stop', async () => {
    const bot = makeBot();
    const { sidecarCalls } = fakeStreaming(bot, 0);

    const first = bot.stopVideoStream('manual', 'Stopped from the web UI');
    const second = bot.stopVideoStream('no_viewers', 'late timer');
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await Promise.all([first, second]);

    assert.equal(bot.videoStreamStatus.lastStop?.reason, 'manual');
    assert.equal(bot.videoStreamStatus.lastStop?.detail, 'Stopped from the web UI');
    assert.equal(sidecarCalls.filter((c) => c === 'stopSource').length, 1);
  });

  it('a volume restart in flight cannot restart ffmpeg after the stream stops', async () => {
    const bot = makeBot();
    const { b, sidecarCalls } = fakeStreaming(bot, 0);
    b._appliedVideoVolume = 50;
    b._videoSource = 'http://example.com/live.ts';
    b._videoSourceMode = 'live';
    b._videoPreset = '720p';
    b._videoEncoder = {
      requested: 'vp8', selected: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, fallbackReason: null, note: null,
    };
    b._videoQuality = {
      requested: '720p', actual: '720p', width: 1280, height: 720, sourceWidth: null, sourceHeight: null, note: null,
    };
    let resolveSource!: () => void;
    const sourceReady = new Promise<void>((r) => { resolveSource = r; });
    b.resolveStreamSource = async () => {
      await sourceReady;
      return { path: 'http://example.com/live.ts', loop: false, durationSec: null };
    };
    b.sidecarHttp.setSource = async () => {
      sidecarCalls.push('setSource');
      return { requested: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, state: 'running' };
    };

    // The restart is waiting on source resolution when the stop begins.
    const push = bot.applyVolume(20);
    await Promise.resolve();
    const stop = bot.stopVideoStream('manual', 'Stopped from the web UI');
    // A change during the stop only updates the saved level.
    await bot.applyVolume(10);
    resolveSource();
    await push;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    mock.timers.tick(1_000);
    await stop;

    assert.equal(sidecarCalls.includes('setSource'), false, `no /source after stop: ${sidecarCalls.join(',')}`);
    assert.equal(sidecarCalls.filter((c) => c === 'stopSource').length, 1);
    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.currentConfig.volume, 10);
  });

  function changingBot() {
    const bot = makeBot();
    const { b, sidecarCalls } = fakeStreaming(bot, 0);
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    b._videoSource = 'http://example.com/old.ts';
    b.applyVideoSource = async (src: string) => {
      log.push(`start:${src}`);
      await new Promise<void>((r) => gates.set(src, r));
      log.push(`end:${src}`);
      sidecarCalls.push(`setSource:${src}`);
      b._appliedVideoVolume = b._videoStreamVolume; // as sendSourceToSidecar records it
    };
    const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    return { bot, b, sidecarCalls, log, gates, settle };
  }

  it('a stop waits for the running source change and drops queued ones', async () => {
    const { bot, sidecarCalls, log, gates, settle } = changingBot();
    const first = bot.setVideoSource('a');
    const queued = bot.setVideoSource('b');
    const queuedResult = queued.then(() => 'ok', (err: Error) => err.message);
    await settle();

    const stop = bot.stopVideoStream('manual', 'Stopped from the web UI');
    await settle();
    assert.equal(sidecarCalls.includes('stopSource'), false, 'stop waits for the change in flight');
    await assert.rejects(() => bot.setVideoSource('c'), /No active video stream/);

    gates.get('a')!();
    await first;
    await settle();
    mock.timers.tick(1_000);
    await stop;

    assert.deepEqual(log, ['start:a', 'end:a'], 'the queued change never runs');
    assert.match(await queuedResult, /No active video stream/);
    assert.ok(sidecarCalls.indexOf('setSource:a') < sidecarCalls.indexOf('stopSource'), sidecarCalls.join(','));
    assert.equal(bot.videoStreaming, false);
  });

  it('a queued source change never reaches a replacement stream', async () => {
    const { bot, b, log, gates, settle } = changingBot();
    const first = bot.setVideoSource('a');
    const queued = bot.setVideoSource('b');
    const queuedResult = queued.then(() => 'ok', (err: Error) => err.message);
    await settle();
    // The sidecar exits and a new stream starts before the queue drains.
    b._activeStreamId = 'stream-2';
    gates.get('a')!();
    await first;
    await settle();

    assert.deepEqual(log, ['start:a', 'end:a']);
    assert.match(await queuedResult, /No active video stream/);
  });
});

describe('video encode health (#72)', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('surfaces a sustained below-realtime warning with context', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    b._videoPreset = '1080p';
    b._videoSourceMode = 'live';
    b._videoEncoder = { requested: 'auto', selected: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, fallbackReason: null, note: null };
    b.sidecarHttp.getStats = async () => ({
      encoder: { state: 'running' },
      health: {
        mode: 'live', speed: 0.55, fps: 16, frames: 900, droppedFrames: 3, duplicatedFrames: 0,
        rtpVideoDrops: 5, rtpAudioDrops: 1, belowRealtime: true, belowRealtimeSecs: 31, sampleAgeSecs: 1,
      },
    });
    await bot.pollVideoHealth();
    const health = bot.videoStreamStatus.health!;
    assert.equal(health.speed, 0.55);
    assert.equal(health.rtpDrops, 6);
    assert.equal(health.belowRealtime, true);
    assert.match(health.warning ?? '', /0\.55x for 31 s, 6 packets dropped\) at 1080p with VP8 \(software\) from a live source/);
    assert.equal(bot.videoStreamStatus.sourceMode, 'live');
  });

  it('stops the stream with a truthful reason when ffmpeg exits', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    b._videoSourceMode = 'live';
    b.sidecarHttp.getStats = async () => ({ encoder: { state: 'exited', exitError: '<source> Server returned 404 Not Found' } });
    const poll = bot.pollVideoHealth();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await poll;
    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.videoStreamStatus.lastStop?.reason, 'source_unreachable');
    assert.match(bot.videoStreamStatus.lastStop?.detail ?? '', /404/);
  });

  it('ignores older sidecars that report no health', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    b.sidecarHttp.getStats = async () => ({ videoPort: 1, audioPort: 2 });
    await bot.pollVideoHealth();
    assert.equal(bot.videoStreaming, true);
    assert.equal(bot.videoStreamStatus.health, null);
  });
});

describe('video source mode lifecycle', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it('clears sourceMode on stop so a later stream cannot inherit Live', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    b._videoSourceMode = 'live';

    const stop = bot.stopVideoStream('source_unreachable', 'Source returned 400 Bad Request');
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await stop;

    assert.equal(b._videoSourceMode, null);
    // Same gap as a YouTube start after IPTV: stream flagged active before setSource.
    b._videoStreaming = true;
    assert.equal(bot.videoStreamStatus.sourceMode, null);
  });

  it('clears sourceMode at the start of applyVideoSource before the download finishes', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    b._videoSourceMode = 'live';
    b._videoSourceModeRequest = 'auto';
    b._videoEncoder = {
      requested: 'vp8', selected: 'vp8', active: 'vp8', codec: 'vp8',
      hardware: false, fallbackReason: null, note: null,
    };
    b._videoSettings = { autoMaxPreset: '1080p', maxBitrateKbps: 0, cpuUsed: 4 };

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    b.resolveStreamSource = async () => {
      await gate;
      return { path: '/data/music/.stream-1.mp4', loop: false, live: undefined, durationSec: 10 };
    };
    b.probeStreamSource = async () => ({ resolution: { width: 1920, height: 1080 }, durationSec: 10 });
    b.sendSourceToSidecar = async (_path: string, _loop: boolean, _quality: unknown, mode: string) => {
      b._videoSourceMode = mode;
      b._videoPreset = '1080p';
      b._videoQuality = { requested: 'auto', actual: '1080p', width: 1920, height: 1080, note: null };
    };

    const apply = b.applyVideoSource('https://www.youtube.com/watch?v=c3hZgGQGLTY', 'auto');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(bot.videoStreamStatus.sourceMode, null, 'must not show Live while preparing the source');

    release();
    await apply;
    assert.equal(bot.videoStreamStatus.sourceMode, 'file');
  });

  it('defers the VOD end timer until the stream is active (startup prepare gap)', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    // Prepare-phase: streaming not yet true (after apply, before setupstream ack).
    b._videoStreaming = false;
    b._videoStarting = true;
    b._videoSourceModeRequest = 'auto';
    b._videoEncoder = {
      requested: 'vp8', selected: 'vp8', active: 'vp8', codec: 'vp8',
      hardware: false, fallbackReason: null, note: null,
    };
    b._videoSettings = { autoMaxPreset: '1080p', maxBitrateKbps: 0, cpuUsed: 4 };
    mock.method(VoiceBot.prototype as any, 'resolveStreamSource', async function (this: any) {
      this._videoDurationSec = 5;
      return {
        path: '/data/music/.stream-1.mp4', loop: false, live: undefined, durationSec: 5,
      };
    });
    mock.method(VoiceBot.prototype as any, 'probeStreamSource', async () => null);
    mock.method(VoiceBot.prototype as any, 'sendSourceToSidecar', async function (this: any) {
      this._videoSourceMode = 'file';
      this._videoLoop = false;
      this._videoPreset = '720p';
    });

    await b.applyVideoSource('https://www.youtube.com/watch?v=c3hZgGQGLTY', '720p');
    assert.equal(b._videoDurationSec, 5);
    assert.equal(b._videoEndTimer, null, 'must not arm end-stop before TeamSpeak confirms the stream');

    b._videoStreaming = true;
    b.scheduleVideoEndStop(b._videoDurationSec);
    assert.notEqual(b._videoEndTimer, null);

    mock.timers.tick(7_000);
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.videoStreamStatus.lastStop?.reason, 'source_ended');
  });

  it('aborts a preparing start when the local sidecar exits before streaming', () => {
    const bot = makeBot();
    const b = bot as any;
    b._videoStarting = true;
    b._videoStreaming = false;
    b._videoTempFile = '/data/music/.stream-1.mp4';
    b._videoSource = 'https://www.youtube.com/watch?v=c3hZgGQGLTY';
    b._videoSourceMode = 'file';
    let rejected: Error | null = null;
    b._videoStartReject = (err: Error) => { rejected = err; };
    b.cleanupVideoTempFile = () => { b._videoTempFile = null; };

    b.abortPendingVideoStart(new Error('Media sidecar exited (code 1)'));

    assert.match(rejected?.message ?? '', /sidecar exited/);
    assert.equal(b._videoSource, null);
    assert.equal(b._videoSourceMode, null);
    assert.equal(b._videoTempFile, null);
    assert.ok(b._videoStartAbortError);
  });

  it('aborts a preparing start when stop is requested before streaming begins', async () => {
    const bot = makeBot();
    const b = bot as any;
    b._videoStarting = true;
    b._videoStreaming = false;
    b._videoSource = 'https://example.com/live.m3u8';
    b._videoSourceMode = 'live';
    let rejected: Error | null = null;
    b._videoStartReject = (err: Error) => { rejected = err; };

    await bot.stopVideoStream('manual', 'Stopped from the web UI');

    assert.match(rejected?.message ?? '', /Stopped from the web UI/);
    assert.ok(b._videoStartAbortError);
    assert.equal(b._videoSource, null);
    assert.equal(b._videoSourceMode, null);
    assert.equal(bot.videoStreaming, false);
  });

  it('keeps a pre-prepare abort marker so source resolution is skipped', async () => {
    const bot = makeBot();
    const b = bot as any;
    b._videoStarting = true;
    b._videoStreaming = false;
    b._videoEncoder = {
      requested: 'vp8', selected: 'vp8', active: 'vp8', codec: 'vp8',
      hardware: false, fallbackReason: null, note: null,
    };
    b._videoSettings = { autoMaxPreset: '1080p', maxBitrateKbps: 0, cpuUsed: 4 };
    b._videoStartAbortError = new Error('Media sidecar exited (code 1)');
    let resolved = false;
    mock.method(VoiceBot.prototype as any, 'resolveStreamSource', async () => {
      resolved = true;
      return { path: '/tmp/x.mp4', loop: false, live: false, durationSec: 10 };
    });

    // Same gate startVideoStreamClaimed uses before applyVideoSource.
    await assert.rejects(async () => {
      if (b._videoStartAbortError) throw b._videoStartAbortError;
      await b.applyVideoSource('https://example.com/a.mp4', '720p');
    }, /sidecar exited/);
    assert.equal(resolved, false, 'must not resolve/download after an abort was already set');
  });

  it('stopstreams a late TeamSpeak confirmation after an aborted start', () => {
    const bot = makeBot();
    const b = bot as any;
    const sent: string[] = [];
    b.client.sendCommand = (cmd: string) => sent.push(cmd);
    b.client.getClientId = () => 42;
    const signaling = new StreamSignaling(b.client);
    b.signaling = signaling;

    b.holdSignalingForLateStop(signaling);
    assert.equal(b.signaling, null, 'bot must detach so a retry can create fresh signaling');

    // Other bots' stream announcements must be ignored.
    signaling.emit('streamStarted', {
      id: 'other-bot',
      clid: 99,
      name: 'Other',
      type: 3,
      access: 1,
      mode: 1,
      bitrate: 0,
      viewerLimit: 0,
      audio: true,
      startedAt: Date.now(),
    });
    assert.equal(sent.length, 0);

    signaling.emit('streamStarted', {
      id: 'late-stream-1',
      clid: 42,
      name: 'Bot Stream',
      type: 3,
      access: 1,
      mode: 1,
      bitrate: 4608,
      viewerLimit: 0,
      audio: true,
      startedAt: Date.now(),
    });

    assert.ok(
      sent.some((c) => c.startsWith('stopstream') && c.includes('late-stream-1')),
      'late confirmation must be stopstreamed',
    );
    assert.equal(bot.videoStreaming, false);
  });

  it('disposes a retained late-stop hold before a retry attaches new signaling', () => {
    const bot = makeBot();
    const b = bot as any;
    const sent: string[] = [];
    b.client.sendCommand = (cmd: string) => sent.push(cmd);
    b.client.getClientId = () => 42;

    const held = new StreamSignaling(b.client);
    let heldStarted = 0;
    held.on('streamStarted', () => { heldStarted++; });
    b.signaling = held;
    b.holdSignalingForLateStop(held);
    assert.equal(b._heldSignalingDispose != null, true);

    // Same path as startVideoStreamClaimed before creating replacement signaling.
    b.disposeHeldSignaling();
    assert.equal(b._heldSignalingDispose, null);

    const retry = new StreamSignaling(b.client);
    b.signaling = retry;
    let retryStarted = 0;
    retry.on('streamStarted', () => { retryStarted++; });

    // A notifystreamstarted must only reach the retry instance.
    b.client.emit('command', {
      name: 'notifystreamstarted',
      params: {
        id: 'retry-stream',
        clid: '42',
        name: 'Bot Stream',
        type: '3',
        access: '1',
        mode: '1',
        bitrate: '4608',
        viewer_limit: '0',
        audio: '1',
      },
    });

    assert.equal(heldStarted, 0, 'disposed hold must not see the retry confirmation');
    assert.equal(retryStarted, 1);
    assert.equal(
      sent.filter((c) => c.startsWith('stopstream')).length,
      0,
      'disposed hold must not stopstream the retry confirmation',
    );
    retry.dispose();
  });

  it('does not stopstream when a replacement signaling already owns the bot', () => {
    const bot = makeBot();
    const b = bot as any;
    const sent: string[] = [];
    b.client.sendCommand = (cmd: string) => sent.push(cmd);
    b.client.getClientId = () => 42;

    const held = new StreamSignaling(b.client);
    b.signaling = held;
    b.holdSignalingForLateStop(held);

    // Simulate a retry that forgot disposeHeldSignaling (belt-and-suspenders path).
    const retry = new StreamSignaling(b.client);
    b.signaling = retry;

    held.emit('streamStarted', {
      id: 'shared-confirm',
      clid: 42,
      name: 'Bot Stream',
      type: 3,
      access: 1,
      mode: 1,
      bitrate: 4608,
      viewerLimit: 0,
      audio: true,
      startedAt: Date.now(),
    });

    assert.equal(
      sent.filter((c) => c.startsWith('stopstream')).length,
      0,
      'held listener must not stopstream when replacement signaling is active',
    );
    assert.equal(b._heldSignalingDispose, null, 'held listener should finish itself');
    retry.dispose();
  });
});

describe('video source probe', () => {
  it('probes remote sources through the sidecar with the source allowlist', async () => {
    const bot = makeBot();
    const b = bot as any;
    const calls: Array<{ source: string; hosts: string[] }> = [];
    b._videoLocalHosts = ['192.168.1.20'];
    b.sidecarHttp = {
      probe: async (source: string, hosts: string[]) => {
        calls.push({ source, hosts });
        return '{"streams":[{"width":1920,"height":1080}],"format":{"duration":"12.5"}}';
      },
    };
    const probe = await b.probeStreamSource('http://192.168.1.20/movie.mp4', false);
    assert.deepEqual(calls, [{ source: 'http://192.168.1.20/movie.mp4', hosts: ['192.168.1.20'] }]);
    assert.deepEqual(probe, { resolution: { width: 1920, height: 1080 }, durationSec: 12.5 });
  });

  it('shares the bot volume with a running video stream and skips a no-op restart', async () => {
    const bot = makeBot();
    assert.equal((bot as any)._videoStreamVolume, 50);
    const { b } = fakeStreaming(bot, 0);
    const volumes: number[] = [];
    b._appliedVideoVolume = 50;
    b._videoSource = 'http://example.com/live.ts';
    b._videoSourceMode = 'live';
    b._videoPreset = '720p';
    b._videoEncoder = {
      requested: 'vp8', selected: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, fallbackReason: null, note: null,
    };
    b._videoQuality = {
      requested: '720p', actual: '720p', width: 1280, height: 720, sourceWidth: null, sourceHeight: null, note: null,
    };
    b.resolveStreamSource = async () => ({ path: b._videoSource, loop: false, durationSec: null });
    b.sidecarHttp.setSource = async (_path: string, opts: { volume?: number }) => {
      volumes.push(opts.volume ?? -1);
      return { requested: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, state: 'running' };
    };

    await bot.applyVolume(50);
    assert.deepEqual(volumes, []);
    await bot.applyVolume(20);
    assert.equal(bot.currentConfig.volume, 20);
    assert.equal((bot as any)._videoStreamVolume, 20);
    assert.deepEqual(volumes, [20]);
    assert.equal((bot as any)._appliedVideoVolume, 20);

    await assert.rejects(() => bot.setVideoStreamVolume(Number.NaN), /volume must be a number/);
  });

  it('pushes a level set during stream startup once the stream is live', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    const volumes: number[] = [];
    // Prepare phase: the sidecar already encodes at 50, TeamSpeak has not confirmed.
    b._videoStreaming = false;
    b._appliedVideoVolume = 50;
    b._videoSource = 'http://example.com/live.ts';
    b._videoSourceMode = 'live';
    b._videoPreset = '720p';
    b._videoEncoder = {
      requested: 'vp8', selected: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, fallbackReason: null, note: null,
    };
    b._videoQuality = {
      requested: '720p', actual: '720p', width: 1280, height: 720, sourceWidth: null, sourceHeight: null, note: null,
    };
    b.resolveStreamSource = async () => ({ path: b._videoSource, loop: false, durationSec: null });
    b.sidecarHttp.setSource = async (_path: string, opts: { volume?: number }) => {
      volumes.push(opts.volume ?? -1);
      return { requested: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, state: 'running' };
    };

    await bot.applyVolume(20);
    assert.deepEqual(volumes, [], 'no restart before the stream is live');
    assert.equal(bot.currentConfig.volume, 20);

    // Same call startVideoStreamClaimed makes right after _videoStreaming = true.
    b._videoStreaming = true;
    await b.scheduleVideoVolumePush();
    assert.deepEqual(volumes, [20]);
    await b.scheduleVideoVolumePush();
    assert.deepEqual(volumes, [20], 'an unchanged level does not restart again');
  });

  it('a volume restart racing a source change never restarts the old source', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    const sent: string[] = [];
    b._appliedVideoVolume = 50;
    b._videoSource = 'http://example.com/old.ts';
    b._videoSourceMode = 'live';
    b._videoPreset = '720p';
    b._videoEncoder = {
      requested: 'vp8', selected: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, fallbackReason: null, note: null,
    };
    b._videoQuality = {
      requested: '720p', actual: '720p', width: 1280, height: 720, sourceWidth: null, sourceHeight: null, note: null,
    };
    let openSource!: () => void;
    const sourceReady = new Promise<void>((r) => { openSource = r; });
    b.resolveStreamSource = async (src: string) => {
      await sourceReady;
      return { path: src, loop: false, durationSec: null };
    };
    b.sidecarHttp.setSource = async (path: string, opts: { volume?: number }) => {
      sent.push(`${path}@${opts.volume}`);
      return { requested: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, state: 'running' };
    };
    // The new source goes to the sidecar at the level current when it is sent;
    // a change after that point must still reach the encoder afterwards.
    b.applyVideoSource = async (src: string) => {
      const vol = b._videoStreamVolume;
      sent.push(`${src}@${vol}`);
      await bot.applyVolume(10);
      b._appliedVideoVolume = vol;
    };

    // A restart for 20 is resolving the old source when the change begins.
    const push = bot.applyVolume(20);
    await Promise.resolve();
    const change = bot.setVideoSource('http://example.com/new.ts');
    openSource();
    await push;
    await change;
    await b._volumePushTail;

    assert.equal(sent.some((s) => s.startsWith('http://example.com/old.ts')), false, `old source restarted: ${sent.join(',')}`);
    assert.deepEqual(sent, ['http://example.com/new.ts@20', 'http://example.com/new.ts@10']);
    assert.equal(b._appliedVideoVolume, 10);
  });

  function sourceChangeBot() {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    const sent: string[] = [];
    b._appliedVideoVolume = 50;
    b._videoSource = 'http://example.com/old.ts';
    b._videoSourceMode = 'live';
    b._videoPreset = '720p';
    b._videoEncoder = {
      requested: 'vp8', selected: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, fallbackReason: null, note: null,
    };
    b._videoQuality = {
      requested: '720p', actual: '720p', width: 1280, height: 720, sourceWidth: null, sourceHeight: null, note: null,
    };
    b.resolveStreamSource = async (src: string) => ({ path: src, loop: false, durationSec: null });
    b.sidecarHttp.setSource = async (path: string, opts: { volume?: number }) => {
      sent.push(`${path}@${opts.volume}`);
      return { requested: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, state: 'running' };
    };
    return { bot, b, sent };
  }

  it('runs overlapping source changes one at a time and holds volume restarts until the last', async () => {
    const { bot, b, sent } = sourceChangeBot();
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    b.applyVideoSource = async (src: string) => {
      const vol = b._videoStreamVolume;
      log.push(`start:${src}`);
      await new Promise<void>((r) => gates.set(src, r));
      log.push(`end:${src}`);
      b._appliedVideoVolume = vol;
    };
    const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

    const first = bot.setVideoSource('a');
    const second = bot.setVideoSource('b');
    await settle();
    assert.deepEqual(log, ['start:a'], 'the second change waits for the first');

    gates.get('a')!();
    await first;
    await settle();
    assert.deepEqual(log, ['start:a', 'end:a', 'start:b']);
    // b is still preparing: a level set now must not restart the encoder yet.
    await bot.applyVolume(30);
    assert.deepEqual(sent, [], 'no restart while a source change is pending');

    gates.get('b')!();
    await second;
    await b._volumePushTail;
    assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b']);
    assert.deepEqual(sent, ['b@30'], 'the level set mid-change reaches the final source');
  });

  it('a failed source change restores the playing source and still applies a pending level', async () => {
    const { bot, b, sent } = sourceChangeBot();
    b.applyVideoSource = async () => {
      b._videoSourceMode = null; // as the real applyVideoSource does before resolving
      await bot.applyVolume(10);
      throw new Error('source unreachable');
    };

    await assert.rejects(() => bot.setVideoSource('http://example.com/broken.ts', undefined, 'live'), /source unreachable/);
    await b._volumePushTail;

    assert.equal(b._videoSource, 'http://example.com/old.ts');
    assert.equal(b._videoSourceMode, 'live');
    assert.deepEqual(sent, ['http://example.com/old.ts@10'], 'the level reaches the source still playing');
  });

  it('treats a failed sidecar probe as unknown without logging the URL', async () => {
    const bot = makeBot();
    const b = bot as any;
    b.sidecarHttp = {
      probe: async () => { throw new Error('Sidecar /probe: 422 probe failed: https://user:pw@iptv.example/x'); },
    };
    const warn = mock.method(console, 'warn', () => {});
    try {
      assert.equal(await b.probeStreamSource('https://user:pw@iptv.example/x', false), null);
      assert.equal(warn.mock.callCount(), 1);
      assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /iptv\.example|pw/);
    } finally {
      warn.mock.restore();
    }
  });
});

describe('video source finished hook', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  type Hook = NonNullable<ConstructorParameters<typeof VoiceBot>[0]['videoSourceFinished']>;

  function hookedBot(hook: Hook) {
    const calls: Array<[string, string | null]> = [];
    const bot = new VoiceBot({
      id: 7,
      serverConfigId: 1,
      name: 'test',
      serverHost: '127.0.0.1',
      serverPort: 9987,
      nickname: 'Bot',
      volume: 50,
      videoSourceFinished: (reason, detail) => {
        calls.push([reason, detail]);
        return hook(reason, detail);
      },
    });
    const { b } = fakeStreaming(bot, 0);
    const stops: unknown[] = [];
    bot.on('videoStreamStopped', (info) => stops.push(info));
    return { bot, b, calls, stops };
  }

  /** Let pending promises settle and the stop's own short timers run. */
  async function settle() {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(1_000);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('end timer asks the hook and does not stop when it advances', async () => {
    const { bot, b, calls, stops } = hookedBot(async () => true);
    b.scheduleVideoEndStop(10);
    mock.timers.tick(12_000);
    await settle();
    assert.deepEqual(calls, [['source_ended', 'Video reached its end']]);
    assert.equal(bot.videoStreaming, true);
    assert.equal(stops.length, 0);
  });

  it('end timer stops as before when the hook declines', async () => {
    const { bot, b, calls } = hookedBot(async () => false);
    b.scheduleVideoEndStop(10);
    mock.timers.tick(12_000);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.videoStreamStatus.lastStop?.reason, 'source_ended');
    assert.equal(bot.videoStreamStatus.lastStop?.detail, 'Video reached its end');
  });

  it('encoder exit asks the hook with the classified reason', async () => {
    const { bot, b, calls, stops } = hookedBot(async () => true);
    b._videoSourceMode = 'vod';
    b.sidecarHttp.getStats = async () => ({ encoder: { state: 'exited', exitError: '<source> Server returned 404 Not Found' } });
    const poll = bot.pollVideoHealth();
    await settle();
    await poll;
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'source_unreachable');
    assert.match(calls[0][1] ?? '', /404/);
    assert.equal(bot.videoStreaming, true);
    assert.equal(stops.length, 0);
  });

  it('a throwing hook falls back to the normal stop', async () => {
    mock.method(console, 'error', () => {});
    const { bot, b } = hookedBot(async () => {
      throw new Error('queue broke');
    });
    b.scheduleVideoEndStop(10);
    mock.timers.tick(12_000);
    await settle();
    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.videoStreamStatus.lastStop?.reason, 'source_ended');
  });

  it('a finish that arrives while the stream is stopping does not ask the hook', async () => {
    const { b, calls } = hookedBot(async () => true);
    b._videoStopping = true;
    await b.handleVideoSourceFinished('source_ended', 'Video reached its end');
    assert.equal(calls.length, 0);
  });

  it('no hook behaves as before', async () => {
    const bot = makeBot();
    const { b } = fakeStreaming(bot, 0);
    b.scheduleVideoEndStop(10);
    mock.timers.tick(12_000);
    await settle();
    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.videoStreamStatus.lastStop?.reason, 'source_ended');
  });
});
