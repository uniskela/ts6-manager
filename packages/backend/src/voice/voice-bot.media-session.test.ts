import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VoiceBot } from './voice-bot.js';
import { VoiceBotManager } from './voice-bot-manager.js';
import { MediaSessionConflictError } from './media-session.js';

function makeBot(id = 7, name = 'Bot'): VoiceBot {
  const bot = new VoiceBot({
    id, serverConfigId: 1, name, serverHost: '127.0.0.1', serverPort: 9987, nickname: name, volume: 50,
  });
  const b = bot as any;
  // Connected, no real TeamSpeak socket.
  b._status = 'connected';
  b.client.sendVoiceStop = () => {};
  b.client.sendCommand = () => {};
  return bot;
}

function fakeMusic(bot: VoiceBot) {
  const b = bot as any;
  b._status = 'playing';
  b._nowPlaying = { id: '1', title: 'Neon Skyline', source: 'local', filePath: '/x.mp3' };
}

function fakeVideo(bot: VoiceBot) {
  const b = bot as any;
  b._videoStreaming = true;
  b._videoSessionId = '11111111-1111-4111-8111-111111111111';
  b._videoSource = 'https://user:pw@iptv.example/live.m3u8';
  b._videoStartedAt = Date.now();
  const stops: string[] = [];
  b.stopVideoStream = async (reason: string) => { stops.push(reason); b._videoStreaming = false; b._videoSessionId = null; };
  return stops;
}

describe('single active media session (per bot)', () => {
  it('refuses video over music until the music session is confirmed', async () => {
    const bot = makeBot();
    fakeMusic(bot);
    const music = bot.musicSessionInfo()!;
    assert.equal(music.kind, 'music');
    assert.equal(music.label, 'Neon Skyline');

    await assert.rejects(bot.startVideoStream('https://example.com/a.mp4'), MediaSessionConflictError);
    assert.equal(bot.status, 'playing', 'unconfirmed start must not touch music');

    let claimedWhileStarting: unknown = null;
    (bot as any).startVideoStreamClaimed = async () => {
      claimedWhileStarting = bot.videoSessionInfo()?.state;
      throw new Error('sidecar down');
    };
    await assert.rejects(
      bot.startVideoStream('https://example.com/a.mp4', { replaceSessionIds: [music.id] }),
      /sidecar down/,
    );
    assert.equal(claimedWhileStarting, 'starting');
    assert.equal(bot.status, 'connected', 'confirmed switch stops music');
    assert.equal(bot.lastMusicStop?.reason, 'replaced_by_video');
    assert.equal(bot.mediaSession, null, 'failed start leaves no session');
  });

  it('rejects a second concurrent video start on the same bot', async () => {
    const bot = makeBot();
    let release!: () => void;
    (bot as any).startVideoStreamClaimed = () => new Promise<void>((r) => { release = r; });
    const first = bot.startVideoStream('https://example.com/a.mp4');
    await assert.rejects(bot.startVideoStream('https://example.com/b.mp4'), /already active/);
    release();
    await first;
  });

  it('refuses music over video until the video session is confirmed', async () => {
    const bot = makeBot();
    const stops = fakeVideo(bot);
    const video = bot.videoSessionInfo()!;
    assert.equal(video.label, 'iptv.example', 'label must not carry credentials');

    const item = { id: '2', title: 'x', source: 'radio' as const, filePath: '', streamUrl: 'http://127.0.0.1:1/none' };
    await assert.rejects(bot.playStream(item), MediaSessionConflictError);
    assert.throws(() => bot.assertMusicCanStart(undefined), MediaSessionConflictError);
    assert.doesNotThrow(() => bot.assertMusicCanStart([video.id]));

    (bot as any).pipeline.toPcmStream = async () => { throw new Error('no network in tests'); };
    await assert.rejects(bot.playStream(item, { replaceSessionIds: [video.id] }), /no network/);
    assert.deepEqual(stops, ['replaced_by_music']);
  });
});

describe('single video stream across bots', () => {
  function manager(bots: VoiceBot[]): VoiceBotManager {
    const m = new VoiceBotManager({} as any, null as any);
    for (const b of bots) (m as any).bots.set(b.id, b);
    return m;
  }

  it('lists every conflict and replaces them only when all are confirmed', async () => {
    const a = makeBot(1, 'Alpha');
    const b = makeBot(2, 'Bravo');
    const stops = fakeVideo(a);
    fakeMusic(b);
    const m = manager([a, b]);
    let started = 0;
    (b as any).startVideoStreamClaimed = async () => { started++; };

    const err = await m.startVideoStream(b, 'https://example.com/v.mp4').catch((e) => e);
    assert.ok(err instanceof MediaSessionConflictError);
    assert.deepEqual(err.conflicts.map((c: any) => `${c.botName}:${c.kind}`), ['Alpha:video', 'Bravo:music']);
    assert.equal(stops.length, 0);

    const ids = err.conflicts.map((c: any) => c.id);
    await m.startVideoStream(b, 'https://example.com/v.mp4', { replaceSessionIds: ids });
    assert.deepEqual(stops, ['replaced_by_video']);
    assert.equal(b.lastMusicStop?.reason, 'replaced_by_video');
    assert.equal(started, 1);
  });

  it('never replaces a stream that is still starting', async () => {
    const a = makeBot(1, 'Alpha');
    const b = makeBot(2, 'Bravo');
    let release!: () => void;
    (a as any).startVideoStreamClaimed = () => new Promise<void>((r) => { release = r; });
    const m = manager([a, b]);
    const first = m.startVideoStream(a, 'https://example.com/a.mp4');
    await new Promise((r) => setImmediate(r));
    const starting = a.videoSessionInfo()!;
    assert.equal(starting.state, 'starting');
    await assert.rejects(
      m.startVideoStream(b, 'https://example.com/b.mp4', { replaceSessionIds: [starting.id] }),
      MediaSessionConflictError,
    );
    release();
    await first;
  });
});

describe('bot hub overview', () => {
  it('summarizes a stream without exposing its source URL', () => {
    const bot = makeBot(4, 'Delta');
    fakeVideo(bot);
    const overview = bot.mediaOverview();
    assert.equal(overview.session?.kind, 'video');
    assert.equal(overview.session?.label, 'iptv.example');
    assert.ok(overview.video, 'video summary present while streaming');
    assert.ok(!JSON.stringify(overview).includes('user:pw'), 'no credentials in the hub payload');
    assert.ok(!('source' in (overview.video as object)));
  });
});
