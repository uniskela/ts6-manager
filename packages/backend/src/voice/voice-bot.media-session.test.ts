import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { VoiceBot } from './voice-bot.js';
import { VoiceBotManager } from './voice-bot-manager.js';
import { MediaSessionConflictError } from './media-session.js';
import { BYTES_PER_FRAME } from './audio/pipeline.js';

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

    const reported: string[] = [];
    bot.on('mediaSessionReplaced', (s: { id: string }) => reported.push(s.id));
    (bot as any).pipeline.toPcmStream = async () => { throw new Error('no network in tests'); };
    await assert.rejects(bot.playStream(item, { replaceSessionIds: [video.id] }), /no network/);
    assert.deepEqual(stops, ['replaced_by_music']);
    assert.deepEqual(reported, [video.id], 'the stop is reported even though the music start failed');
  });

  it('keeps the music session when a YouTube stream falls back to a download', async () => {
    const bot = makeBot();
    fakeMusic(bot);
    const b = bot as any;
    const before = bot.musicSessionInfo()!;
    const item = { id: '3', title: 'Clip', source: 'youtube' as const, filePath: '', sourceUrl: 'https://youtu.be/x' };
    b._nowPlaying = item;
    const opened: string[] = [];
    const procs: EventEmitter[] = [];
    b.pipeline.toPcmFileStream = async (input: string) => {
      opened.push(input);
      const process = new EventEmitter();
      procs.push(process);
      return { stdout: new PassThrough(), process, kill: () => {} };
    };
    b.ensurePlayableFile = async () => '/data/music/clip.m4a';

    await b.startFileStream('https://rr1.googlevideo.com/a', 0, () => b.playDownloadFallback(item));
    // ffmpeg could not open the URL: no audio, non-zero exit.
    procs[0].emit('close', 1);
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(opened, ['https://rr1.googlevideo.com/a', '/data/music/clip.m4a']);
    assert.equal(bot.status, 'playing', 'the download plays the same item');
    assert.equal(bot.musicSessionInfo()?.id, before.id);
    assert.equal(bot.lastMusicStop, null);
    b.stopPlayback();

    // Without a pending fallback a failed radio stream ends the session.
    b.pipeline.toPcmStream = async () => { throw new Error('403'); };
    await assert.rejects(bot.playStream({ ...item, source: 'radio' as const, streamUrl: 'https://example.com/a' }), /403/);
    assert.equal(bot.musicSessionInfo(), null);
    assert.equal(bot.lastMusicStop?.reason, 'source_unreachable');
  });

  it('keeps a pending download through pause and starts it paused', async () => {
    const bot = makeBot();
    fakeMusic(bot);
    const b = bot as any;
    const item = { id: '4', title: 'Clip', source: 'youtube' as const, filePath: '', sourceUrl: 'https://youtu.be/y' };
    b._nowPlaying = item;
    const procs: EventEmitter[] = [];
    const outs: PassThrough[] = [];
    b.pipeline.toPcmFileStream = async () => {
      const process = new EventEmitter();
      const stdout = new PassThrough();
      procs.push(process);
      outs.push(stdout);
      return { stdout, process, kill: () => {} };
    };
    let finishDownload!: (p: string) => void;
    b.ensurePlayableFile = () => new Promise<string>((r) => { finishDownload = r; });

    await b.startFileStream('https://rr1.googlevideo.com/b', 0, () => b.playDownloadFallback(item));
    procs[0].emit('close', 1);
    bot.pause();
    finishDownload('/data/music/clip.m4a');
    await new Promise((r) => setImmediate(r));

    assert.equal(procs.length, 2, 'the download was started');
    assert.equal(bot.status, 'paused');
    assert.equal(outs[1].isPaused(), true);
    bot.resume();
    assert.equal(bot.status, 'playing');
    assert.equal(outs[1].isPaused(), false);
    b.stopPlayback();
  });

  it('downloads and resumes at the seek target when a streamed URL has expired', async () => {
    const bot = makeBot();
    fakeMusic(bot);
    const b = bot as any;
    const item = { id: '5', title: 'Clip', source: 'youtube' as const, filePath: '', sourceUrl: 'https://youtu.be/z', duration: 300 };
    b._nowPlaying = item;
    const opened: Array<[string, number]> = [];
    const procs: EventEmitter[] = [];
    b.pipeline.toPcmFileStream = async (input: string, start: number) => {
      opened.push([input, start]);
      const process = new EventEmitter();
      procs.push(process);
      return { stdout: new PassThrough(), process, kill: () => {} };
    };
    b.ensurePlayableFile = async () => '/data/music/clip.m4a';

    await b.startFileStream('https://rr1.googlevideo.com/d', 0);
    await bot.seek(90);
    procs[1].emit('close', 1);
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(opened[2], ['/data/music/clip.m4a', 90]);
    assert.equal(bot.status, 'playing');
    b.stopPlayback();
  });

  it('does not start a track that was stopped while it downloaded', async () => {
    const bot = makeBot();
    const b = bot as any;
    let opened = 0;
    b.pipeline.toPcmFileStream = async () => {
      opened++;
      return { stdout: new PassThrough(), process: new EventEmitter(), kill: () => {} };
    };
    let finishDownload!: (p: string) => void;
    b.ensurePlayableFile = () => new Promise<string>((r) => { finishDownload = r; });

    const playing = bot.play({ id: '6', title: 'Song', source: 'local' as const, filePath: '' });
    await new Promise((r) => setImmediate(r));
    bot.clearPlayback();
    finishDownload('/data/music/song.mp3');
    await playing;

    assert.equal(opened, 0);
    assert.equal(bot.status, 'connected');
    assert.equal(bot.lastMusicStop?.reason, 'manual');
  });

  it('leaves a newer track alone when a paused seek loses ownership', async () => {
    const bot = makeBot();
    fakeMusic(bot);
    const b = bot as any;
    const outs: PassThrough[] = [];
    let calls = 0;
    let release: (() => void) | null = null;
    b.pipeline.toPcmFileStream = async () => {
      const call = ++calls;
      if (call === 2) await new Promise<void>((r) => { release = r; });
      const stdout = new PassThrough();
      outs.push(stdout);
      return { stdout, process: new EventEmitter(), kill: () => {} };
    };

    await b.startFileStream('/x.mp3', 0);
    bot.pause();
    const seeking = bot.seek(30);
    await new Promise((r) => setImmediate(r));
    // A new track takes over while the seek's decoder is still opening.
    b.stopPlayback();
    b._status = 'playing';
    await b.startFileStream('/next.mp3', 0);
    release!();
    await seeking;

    assert.equal(outs[outs.length - 1].isPaused(), false, 'the new track keeps playing');
    assert.ok(b.playbackTimer, 'its playback timer is untouched');
    b.stopPlayback();
  });

  it('drops a file stream whose start lost ownership while the URL was checked', async () => {
    const bot = makeBot();
    fakeMusic(bot);
    const b = bot as any;
    let killed = false;
    let release!: () => void;
    b.pipeline.toPcmFileStream = async () => {
      await new Promise<void>((r) => { release = r; });
      return { stdout: new PassThrough(), process: new EventEmitter(), kill: () => { killed = true; } };
    };

    const start = b.startFileStream('https://rr1.googlevideo.com/c', 0);
    await new Promise((r) => setImmediate(r));
    b.stopPlayback();
    release();
    await start;

    assert.equal(killed, true);
    assert.equal(bot.canSeek, false);
  });

  it('plays a streamed YouTube track to the end instead of stopping when the download finishes', async () => {
    const bot = makeBot();
    fakeMusic(bot);
    const b = bot as any;
    b.client.sendVoice = () => {};
    const stdout = new PassThrough();
    const process = new EventEmitter();
    b.pipeline.toPcmFileStream = async () => ({ stdout, process, kill: () => {} });

    await b.startFileStream('https://rr1.googlevideo.com/a', 0, () => assert.fail('no fallback once audio arrived'));
    stdout.write(Buffer.alloc(BYTES_PER_FRAME * 10));
    await new Promise((r) => setImmediate(r));
    // ffmpeg has read the whole source while most of it is still buffered.
    process.emit('close', 0);

    assert.equal(bot.status, 'playing');
    assert.equal(bot.lastMusicStop, null);
    assert.equal(bot.canSeek, true, 'a streamed track seeks like a file');
    b.stopPlayback();
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
    const reported: string[] = [];
    m.on('mediaSessionReplaced', (s: { botName: string; kind: string }) => reported.push(`${s.botName}:${s.kind}`));
    b.on('mediaSessionReplaced', (s: { botName: string; kind: string }) => reported.push(`${s.botName}:${s.kind}`));
    const replaced = await m.startVideoStream(b, 'https://example.com/v.mp4', { replaceSessionIds: ids });
    assert.deepEqual(reported, ['Alpha:video', 'Bravo:music'], 'each stop is reported once, as it happens');
    assert.deepEqual(stops, ['replaced_by_video']);
    assert.equal(b.lastMusicStop?.reason, 'replaced_by_video');
    assert.equal(started, 1);
    assert.deepEqual(replaced.map((s) => `${s.botName}:${s.kind}`), ['Alpha:video', 'Bravo:music']);
  });

  it('omits sessions that ended before the lock-held stop', async () => {
    const a = makeBot(1, 'Alpha');
    const b = makeBot(2, 'Bravo');
    fakeVideo(a);
    const m = manager([a, b]);
    (b as any).startVideoStreamClaimed = async () => {};
    const session = a.videoSessionInfo()!;
    let infoCalls = 0;
    a.videoSessionInfo = () => {
      infoCalls++;
      // assertVideoCanStart sees the session; the lock-held capture does not.
      return infoCalls === 1 ? session : null;
    };
    (a as any).stopVideoStream = async () => {};
    const replaced = await m.startVideoStream(b, 'https://example.com/v.mp4', {
      replaceSessionIds: [session.id],
    });
    assert.deepEqual(replaced, []);
    assert.ok(infoCalls >= 2);
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

describe('music session end', () => {
  it('ends the session when the queue runs out', () => {
    const bot = makeBot();
    fakeMusic(bot);
    const first = bot.musicSessionInfo()!;
    (bot as any).finishFileTrack();
    assert.equal(bot.status, 'connected');
    assert.equal(bot.lastMusicStop?.reason, 'source_ended');
    fakeMusic(bot);
    assert.notEqual(bot.musicSessionInfo()!.id, first.id, 'later music is a new session');
  });
});
