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
