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
