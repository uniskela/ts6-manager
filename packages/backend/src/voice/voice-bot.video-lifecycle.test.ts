import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { VoiceBot } from './voice-bot.js';

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
  return { b, sidecarCalls };
}

describe('video no-viewer auto-stop', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
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
