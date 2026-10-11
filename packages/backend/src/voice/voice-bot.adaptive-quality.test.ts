import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { VideoQualityRequest, VideoSourceMode, VideoStreamPresetKey } from '@ts6/common';
import { VoiceBot } from './voice-bot.js';
import { AdaptiveQualityController } from './streaming/adaptive-quality.js';
import { resolveQuality } from './streaming/quality.js';
import type { SidecarStreamHealth } from './streaming/sidecar-client.js';

const POLL_MS = 10_000;

function health(over: Partial<SidecarStreamHealth> = {}): SidecarStreamHealth {
  return {
    mode: 'live', speed: 1, fps: 30, frames: 100, droppedFrames: 0, duplicatedFrames: 0,
    rtpVideoDrops: 0, rtpAudioDrops: 0, belowRealtime: false, belowRealtimeSecs: 0, sampleAgeSecs: 1,
    ...over,
  };
}
const overloaded = (over: Partial<SidecarStreamHealth> = {}) =>
  health({ speed: 0.6, belowRealtime: true, belowRealtimeSecs: 30, ...over });

/** A bot that is "streaming" against a scripted sidecar, with no TeamSpeak server. */
function streamingBot(requested: VideoQualityRequest, start: VideoStreamPresetKey, mode: VideoSourceMode) {
  const bot = new VoiceBot({
    id: 7, serverConfigId: 1, name: 'test', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50,
  });
  const b = bot as any;
  const sources: Array<Record<string, unknown>> = [];
  const sidecar = {
    next: health() as SidecarStreamHealth,
    failSources: 0,
    calls: [] as string[],
  };
  b._videoStreaming = true;
  b._activeStreamId = 'stream-1';
  b._videoStartedAt = Date.now();
  b._videoSource = mode === 'live' ? 'https://iptv.example/live' : 'https://cdn.example/film.mp4';
  b._videoSourceMode = mode;
  b._videoQuality = requested === 'auto'
    ? { ...resolveQuality('auto', start, { width: 3840, height: 2160 }), note: null }
    : resolveQuality(requested, start, null);
  b._videoPreset = b._videoQuality.actual;
  b._videoEncoder = {
    requested: 'auto', selected: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, fallbackReason: null, note: null,
  };
  b._videoAdaptive = requested === 'auto' ? new AdaptiveQualityController(start) : null;
  b.resolveRunningSource = async () => ({ sourcePath: b._videoSource, loop: false });
  b.sendChannelMessage = () => {};
  b.signaling = { sendRemoveClient: () => {}, sendStreamStop: () => {}, dispose: () => {} };
  b.sidecarHttp = {
    getStats: async () => ({ encoder: { state: 'running' }, health: sidecar.next }),
    setSource: async (_source: string, options: Record<string, unknown>) => {
      if (sidecar.failSources > 0) {
        sidecar.failSources--;
        sources.push({ ...options, failed: true });
        throw new Error('Sidecar /source: 500 start ffmpeg');
      }
      sources.push(options);
      return { requested: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, state: 'running' };
    },
    stopSource: async () => { sidecar.calls.push('stopSource'); },
    closePeer: async () => {},
  };
  /** One health poll, 10 s after the last. */
  const poll = async (next: SidecarStreamHealth) => {
    sidecar.next = next;
    mock.timers.tick(POLL_MS);
    await bot.pollVideoHealth();
  };
  return { bot, b, sidecar, sources, poll };
}

describe('adaptive Auto quality on a running stream', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('steps an overloaded Auto stream down one preset and reports why', async () => {
    const { bot, sources, poll } = streamingBot('auto', '1080p', 'live');
    const changes: any[] = [];
    bot.on('videoQualityChanged', (c) => changes.push(c));

    await poll(health({ speed: 0.7, belowRealtimeSecs: 10 }));
    assert.equal(sources.length, 0, 'a short dip changes nothing');

    await poll(overloaded({ speed: 0.62 }));
    assert.equal(sources.length, 1);
    assert.deepEqual(
      { width: sources[0].width, height: sources[0].height, bitrate: sources[0].bitrate, encoder: sources[0].encoder },
      { width: 1280, height: 720, bitrate: '2500k', encoder: 'vp8' },
      'the next preset down, on the same encoder',
    );
    assert.equal('startAtSecs' in sources[0], false, 'a live source has no position to resume');

    const status = bot.videoStreamStatus;
    assert.equal(status.preset, '720p');
    assert.equal(status.quality?.requested, 'auto');
    assert.equal(status.quality?.actual, '720p');
    assert.deepEqual(status.quality?.adaptation, {
      ceiling: '1080p',
      changes: 1,
      lastChange: {
        direction: 'down', from: '1080p', to: '720p', at: Date.now(),
        reason: 'Encoding stayed below realtime (0.62x for 30 s) at 1080p',
      },
    });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].ceiling, '1080p');
  });

  it('never changes a fixed preset', async () => {
    const { bot, sources, poll } = streamingBot('1080p', '1080p', 'live');
    for (let i = 0; i < 30; i++) await poll(overloaded({ belowRealtimeSecs: 30 + i * 10 }));
    assert.equal(sources.length, 0);
    assert.equal(bot.videoStreamStatus.quality?.actual, '1080p');
    assert.equal(bot.videoStreamStatus.quality?.adaptation, null);
    assert.match(bot.videoStreamStatus.health?.warning ?? '', /below realtime/, 'the warning is still shown');
  });

  it('steps back up after a stable recovery, one preset at a time, never above where Auto started', async () => {
    const { bot, sources, poll } = streamingBot('auto', '1080p', 'live');
    await poll(overloaded());
    for (let i = 0; i < 6; i++) await poll(overloaded({ belowRealtimeSecs: 30 + i * 10 }));
    assert.deepEqual(sources.map((s) => s.height), [720, 480], 'a cooldown apart');

    for (let i = 0; i < 200; i++) await poll(health());
    assert.deepEqual(sources.map((s) => s.height), [720, 480, 720, 1080]);
    assert.equal(bot.videoStreamStatus.quality?.actual, '1080p');
    assert.equal(bot.videoStreamStatus.quality?.adaptation?.lastChange?.direction, 'up');
  });

  it('resumes an on-demand video where it was instead of replaying it', async () => {
    const { b, sidecar, sources, poll } = streamingBot('auto', '1080p', 'vod');
    b._videoDurationSec = 3600;
    const ended: string[] = [];
    b.handleVideoSourceFinished = async (reason: string) => { ended.push(reason); };

    await poll(overloaded({ mode: 'vod', positionSecs: 754.5 }));
    assert.equal(sources.length, 1);
    assert.equal(sources[0].startAtSecs, 754.5);
    assert.equal(sources[0].mode, 'vod');

    // The end-of-video stop now counts the remaining time, not the full length.
    sidecar.next = health({ mode: 'vod', positionSecs: 760 });
    mock.timers.tick((3600 - 754.5) * 1000);
    assert.deepEqual(ended, []);
    mock.timers.tick(3_000);
    assert.deepEqual(ended, ['source_ended']);
  });

  it('wraps the position of a looped local file', async () => {
    const { b, sources, poll } = streamingBot('auto', '1080p', 'file');
    b._videoSource = '/data/music/background.mp4';
    b._videoSourceDurationSec = 600;
    b.resolveRunningSource = async () => ({ sourcePath: b._videoSource, loop: true });
    b.sidecarHttp.setSource = async (_s: string, options: Record<string, unknown>) => { sources.push(options); return null; };
    await poll(overloaded({ mode: 'file', positionSecs: 1500 }));
    assert.equal(sources[0].startAtSecs, 300);
    assert.equal(sources[0].loop, true);
  });

  it('leaves an on-demand video alone when the sidecar cannot report its position', async () => {
    const { bot, sources, poll } = streamingBot('auto', '1080p', 'vod');
    for (let i = 0; i < 30; i++) await poll(overloaded({ mode: 'vod', belowRealtimeSecs: 30 + i * 10 }));
    assert.equal(sources.length, 0, 'a restart would replay the video from the start');
    assert.equal(bot.videoStreamStatus.quality?.actual, '1080p');
  });

  it('does not restart a video that is about to end', async () => {
    const { b, sources, poll } = streamingBot('auto', '1080p', 'vod');
    b._videoDurationSec = 600;
    await poll(overloaded({ mode: 'vod', positionSecs: 592 }));
    assert.equal(sources.length, 0);
  });

  it('goes back to the working quality when the new encode does not start', async () => {
    const { bot, sidecar, sources, poll } = streamingBot('auto', '1080p', 'live');
    sidecar.failSources = 1;
    await poll(overloaded());
    assert.deepEqual(sources.map((s) => [s.height, !!s.failed]), [[720, true], [1080, false]]);
    assert.equal(bot.videoStreaming, true);
    assert.equal(bot.videoStreamStatus.quality?.actual, '1080p');
    assert.equal(bot.videoStreamStatus.quality?.adaptation?.changes, 0);

    // It tries again, but not before a cooldown.
    await poll(overloaded({ belowRealtimeSecs: 40 }));
    assert.equal(sources.length, 2);
    for (let i = 0; i < 6; i++) await poll(overloaded({ belowRealtimeSecs: 50 + i * 10 }));
    assert.equal(sources.length, 3);
    assert.equal(bot.videoStreamStatus.quality?.actual, '720p');
  });

  it('stops with a truthful reason when the encoder will not restart at all', async () => {
    const { bot, sidecar, sources, poll } = streamingBot('auto', '1080p', 'live');
    sidecar.failSources = 2;
    await poll(overloaded());
    assert.equal(sources.length, 2);
    // stopVideoStream waits 1 s for stopstream to flush.
    await new Promise<void>((resolve) => setImmediate(resolve));
    mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.videoStreamStatus.lastStop?.reason, 'encoder_failure');
    assert.equal(bot.videoStreamStatus.lastStop?.detail, 'The encoder did not restart after an automatic quality change');
    assert.ok(sidecar.calls.includes('stopSource'));
  });

  it('does not restart the encoder once the stream is stopping', async () => {
    const { bot, b, sources, sidecar } = streamingBot('auto', '1080p', 'live');
    let release!: () => void;
    b.resolveRunningSource = () => new Promise((resolve) => {
      release = () => resolve({ sourcePath: b._videoSource, loop: false });
    });
    sidecar.next = overloaded();
    mock.timers.tick(POLL_MS);
    const polling = bot.pollVideoHealth();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stopping = bot.stopVideoStream('manual', 'stopped by an admin');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sidecar.calls, [], 'the stop waits for the change in flight');
    release();
    await polling;
    await new Promise<void>((resolve) => setImmediate(resolve));
    mock.timers.tick(1_000);
    await stopping;

    assert.equal(sources.length, 0, 'no /source after the stop began');
    assert.equal(bot.videoStreaming, false);
    assert.equal(bot.videoStreamStatus.lastStop?.reason, 'manual');
  });

  it('keeps no adaptation state once the stream stops', async () => {
    const { b } = streamingBot('auto', '1080p', 'live');
    b._videoAdaptive.commit(b._videoAdaptive.observe(
      { speed: 0.6, belowRealtime: true, belowRealtimeSecs: 30, sampleAgeSecs: 1 }, Date.now(),
    ), Date.now());
    assert.equal(b._videoAdaptive.current, '720p');
    b.stopHealthMonitor();
    assert.equal(b._videoAdaptive, null, 'a stopped stream keeps no adaptation state');
  });
});
