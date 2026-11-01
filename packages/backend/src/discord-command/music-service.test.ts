import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultMediaCommandPermissions, type MediaCommandPermissions } from '../voice/media-command-permissions.js';
import type { MediaUrlPipelineDeps } from '../voice/media-url-pipeline.js';
import { PlayQueue, type QueueItem } from '../voice/playlist/queue.js';
import { createDiscordCommandAdapter, type DiscordCommandDeps, type DiscordCommandIntent } from './adapter.js';
import { createMusicCommandService } from './music-service.js';
import { MemoryReplayGuard } from './security.js';

const GUILD = '111';
const DJ = 'u-dj';
const VIEWER = 'u-view';
const DJ_ROLE = 'r-dj';
const VIEWER_ROLE = 'r-view';
const restricted: MediaCommandPermissions = {
  playback: { mode: 'server_groups', serverGroupIds: [9] },
  queue: { mode: 'server_groups', serverGroupIds: [9] },
  video: { mode: 'server_groups', serverGroupIds: [9] },
};

function track(id: string, title = id): QueueItem {
  return { id, title, artist: 'A', filePath: `/tmp/${id}`, source: 'url', sourceUrl: `https://8.8.8.8/${id}` };
}

function stubPipeline(item: QueueItem): MediaUrlPipelineDeps {
  return {
    resolveSpotify: async (url) => url,
    resolveAppleMusic: async () => ({ tracks: [] }),
    resolveSpotifyCollection: async () => null,
    appleTrackToYouTube: async () => null,
    expandYouTube: async () => null,
    downloadTrack: async () => item,
  };
}

function fakeBot(status: 'connected' | 'playing' | 'paused' | 'stopped' = 'connected') {
  const bot: any = {
    currentConfig: { id: 1, serverConfigId: 9, serverPort: 10011, volume: 40 },
    status,
    nowPlaying: null,
    isStreaming: false,
    playbackProgress: { position: 12, duration: 120 },
    queue: new PlayQueue(),
    assertMusicCanStart: () => {},
    pause() {
      if (bot.status === 'playing') bot.status = 'paused';
    },
    resume() {
      if (bot.status === 'paused') bot.status = 'playing';
    },
    stopAudio(options?: { keepPendingRequests?: boolean }) {
      bot.lastStop = options;
      bot.nowPlaying = null;
      if (bot.status === 'playing' || bot.status === 'paused') bot.status = 'connected';
      bot.isStreaming = false;
    },
    applyVolume: async (volume: number) => {
      bot.currentConfig.volume = volume;
    },
    play: async (item: QueueItem) => {
      bot.nowPlaying = item;
      bot.status = 'playing';
    },
    playStream: async (item: QueueItem) => {
      bot.nowPlaying = item;
      bot.status = 'playing';
    },
  };
  return bot;
}

function serviceOpts(bot: any, overrides: Record<string, unknown> = {}) {
  return {
    getBot: (id: number) => (id === 1 ? bot : null),
    virtualServerIdForBot: () => 2,
    loadMediaPermissions: async () => defaultMediaCommandPermissions(),
    pipeline: stubPipeline(track('t1', 'Track One')),
    replay: new MemoryReplayGuard(),
    ...overrides,
  };
}

function musicIntent(partial: Partial<DiscordCommandIntent> & Pick<DiscordCommandIntent, 'command'>): DiscordCommandIntent {
  return {
    guildId: GUILD,
    userId: DJ,
    roleIds: [DJ_ROLE],
    memberPermissions: '0',
    ...partial,
  };
}

function adapterDeps(bot: any, extras: Partial<DiscordCommandDeps> = {}): DiscordCommandDeps {
  return {
    bindings: {
      get: (guildId) => guildId === GUILD ? { instanceId: 'inst-1', revoked: false, botId: 1 } : null,
    },
    policy: { viewerRoleIds: [VIEWER_ROLE], adminRoleIds: [DJ_ROLE] },
    presence: { async snapshot() { return null; } },
    bridge: { async health() { return null; } },
    audit: () => {},
    music: createMusicCommandService(serviceOpts(bot)),
    ...extras,
  };
}

describe('Discord music service shares TeamSpeak playback state', () => {
  it('lets /play and a TeamSpeak enqueue share one queue', async () => {
    const bot = fakeBot();
    const music = createMusicCommandService(serviceOpts(bot, {
      pipeline: stubPipeline(track('from-discord', 'Discord Track')),
    }));
    const discord = await music.execute(musicIntent({
      command: 'play',
      args: { query: 'https://8.8.8.8/discord.mp3' },
      idempotencyKey: 'ix-1',
    }), { instanceId: 'inst-1', revoked: false, botId: 1 });
    assert.equal(discord.ok, true);
    assert.equal(bot.nowPlaying?.title, 'Discord Track');

    const { enqueueMediaUrl } = await import('../voice/commands/queue.js');
    const context: any = {
      voiceBotManager: { getBot: () => bot },
      virtualServerIdForBot: () => 2,
      joinChannelForCommand: async () => {},
      chatMusicSwitch: () => undefined,
      saveMusicRequest: () => {},
      reply: () => {},
    };
    await enqueueMediaUrl(
      context, 1, bot, 7, 'https://8.8.8.8/chat.mp3', undefined,
      stubPipeline(track('from-chat', 'Chat Track')),
    );
    assert.equal(bot.nowPlaying?.title, 'Discord Track');
    assert.equal(bot.queue.getAll().some((item: QueueItem) => item.title === 'Chat Track'), true);

    const queue = await music.execute(musicIntent({ command: 'queue' }), { instanceId: 'inst-1', revoked: false, botId: 1 });
    const now = await music.execute(musicIntent({ command: 'nowplaying' }), { instanceId: 'inst-1', revoked: false, botId: 1 });
    assert.match(queue.content, /Discord Track|Chat Track/);
    assert.match(now.content, /Discord Track/);
    assert.equal(queue.ephemeral, true);
    assert.equal(now.ephemeral, true);
  });

  it('denies playback mutations without media permission', async () => {
    const bot = fakeBot();
    const music = createMusicCommandService(serviceOpts(bot, {
      loadMediaPermissions: async () => restricted,
    }));
    const result = await music.execute(musicIntent({
      command: 'play',
      args: { query: 'https://8.8.8.8/x.mp3' },
    }), { instanceId: 'inst-1', revoked: false, botId: 1 });
    assert.equal(result.code, 'unauthorized');
    assert.equal(bot.nowPlaying, null);
    assert.equal(bot.queue.length, 0);
  });

  it('rejects unpaired or revoked guilds before touching the bot', async () => {
    const bot = fakeBot();
    let gets = 0;
    const music = createMusicCommandService(serviceOpts(bot, {
      getBot: () => { gets += 1; return bot; },
    }));
    const unpaired = await music.execute(musicIntent({ command: 'play', args: { query: 'https://8.8.8.8/x.mp3' } }), null);
    const revoked = await music.execute(
      musicIntent({ command: 'queue' }),
      { instanceId: 'inst-1', revoked: true, botId: 1 },
    );
    assert.equal(unpaired.code, 'unpaired');
    assert.equal(revoked.code, 'unpaired');
    assert.equal(gets, 0);
  });

  it('does not enqueue twice for the same Discord interaction', async () => {
    const bot = fakeBot('playing');
    bot.nowPlaying = track('cur', 'Current');
    const music = createMusicCommandService(serviceOpts(bot, {
      pipeline: stubPipeline(track('once', 'Once')),
    }));
    const binding = { instanceId: 'inst-1', revoked: false, botId: 1 };
    const intent = musicIntent({
      command: 'play',
      args: { query: 'https://8.8.8.8/once.mp3' },
      idempotencyKey: 'retry-1',
    });
    const first = await music.execute(intent, binding);
    const second = await music.execute(intent, binding);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(bot.queue.getAll().filter((item: QueueItem) => item.title === 'Once').length, 1);
  });

  it('rejects a private URL without downloading', async () => {
    let downloads = 0;
    const bot = fakeBot();
    const music = createMusicCommandService(serviceOpts(bot, {
      pipeline: {
        ...stubPipeline(track('bad')),
        downloadTrack: async () => { downloads += 1; throw new Error('must not download'); },
      },
    }));
    const result = await music.execute(musicIntent({
      command: 'play',
      args: { query: 'http://127.0.0.1/secret.mp3' },
    }), { instanceId: 'inst-1', revoked: false, botId: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unavailable');
    assert.equal(downloads, 0);
    assert.equal(bot.queue.length, 0);
  });

  it('fails closed when the music bot is missing', async () => {
    const music = createMusicCommandService(serviceOpts(fakeBot(), { getBot: () => null }));
    const result = await music.execute(musicIntent({ command: 'nowplaying' }), {
      instanceId: 'inst-1', revoked: false, botId: 1,
    });
    assert.equal(result.code, 'unavailable');
  });
});

describe('Discord adapter music wiring', () => {
  it('routes /play through the bound bot, never a client-supplied bot id', async () => {
    const bot = fakeBot();
    const adapter = createDiscordCommandAdapter(adapterDeps(bot));
    const result = await adapter.handle(musicIntent({
      command: 'play',
      args: { query: 'https://8.8.8.8/discord.mp3', botId: '99' },
      userId: DJ,
    }));
    assert.equal(result.ok, true);
    assert.equal(bot.nowPlaying?.title, 'Track One');
    assert.equal(result.ack, 'deferred');
  });

  it('keeps Phase 2B-2 playlist and radio unimplemented', async () => {
    const adapter = createDiscordCommandAdapter(adapterDeps(fakeBot()));
    for (const command of ['playlist', 'radio']) {
      const result = await adapter.handle(musicIntent({ command, userId: DJ }));
      assert.equal(result.code, 'not_implemented', command);
    }
  });
});

describe('Discord playback controls share TeamSpeak bot state', () => {
  const binding = { instanceId: 'inst-1', revoked: false, botId: 1 };

  it('pauses and resumes explicitly and idempotently', async () => {
    const bot = fakeBot('playing');
    bot.nowPlaying = track('cur', 'Current');
    const music = createMusicCommandService(serviceOpts(bot));
    const paused = await music.execute(musicIntent({ command: 'pause' }), binding);
    assert.equal(paused.ok, true);
    assert.equal(paused.ack, 'immediate');
    assert.equal(bot.status, 'paused');
    const pausedAgain = await music.execute(musicIntent({ command: 'pause' }), binding);
    assert.equal(pausedAgain.ok, true);
    assert.equal(bot.status, 'paused');
    const resumed = await music.execute(musicIntent({ command: 'resume' }), binding);
    assert.equal(resumed.ok, true);
    assert.equal(bot.status, 'playing');
    const resumedAgain = await music.execute(musicIntent({ command: 'resume' }), binding);
    assert.equal(resumedAgain.ok, true);
    assert.equal(bot.status, 'playing');
  });

  it('skips to the next queued track and shares that state with TeamSpeak', async () => {
    const bot = fakeBot('playing');
    bot.queue.addMany([track('a', 'One'), track('b', 'Two')]);
    bot.queue.playAt(0);
    bot.nowPlaying = bot.queue.current;
    const music = createMusicCommandService(serviceOpts(bot));
    const skipped = await music.execute(musicIntent({ command: 'skip' }), binding);
    assert.equal(skipped.ok, true);
    assert.match(skipped.content, /Two/);
    assert.equal(bot.nowPlaying?.title, 'Two');
    assert.equal(bot.queue.current?.title, 'Two');
  });

  it('skip on an empty queue stops audio but keeps pending downloads', async () => {
    const bot = fakeBot('playing');
    bot.nowPlaying = track('only', 'Only');
    const music = createMusicCommandService(serviceOpts(bot));
    const skipped = await music.execute(musicIntent({ command: 'skip' }), binding);
    assert.equal(skipped.ok, true);
    assert.equal(bot.status, 'connected');
    assert.deepEqual(bot.lastStop, { keepPendingRequests: true });
  });

  it('stop clears a music queue and reports playback errors', async () => {
    const bot = fakeBot('playing');
    bot.queue.addMany([track('a', 'One'), track('b', 'Two')]);
    bot.queue.playAt(0);
    bot.nowPlaying = bot.queue.current;
    const music = createMusicCommandService(serviceOpts(bot));
    const stopped = await music.execute(musicIntent({ command: 'stop' }), binding);
    assert.equal(stopped.ok, true);
    assert.equal(bot.queue.length, 0);
    assert.equal(bot.nowPlaying, null);
    assert.equal(bot.lastStop, undefined);

    bot.play = async () => { throw new Error('decoder failed'); };
    bot.queue.addMany([track('c', 'Three'), track('d', 'Four')]);
    bot.queue.playAt(0);
    bot.status = 'playing';
    const failedSkip = await music.execute(musicIntent({ command: 'skip' }), binding);
    assert.equal(failedSkip.ok, false);
    assert.equal(failedSkip.code, 'unavailable');
    assert.match(failedSkip.content, /decoder failed/);
  });

  it('stop during radio keeps queued songs', async () => {
    const bot = fakeBot('playing');
    bot.isStreaming = true;
    bot.queue.addMany([track('a', 'Song A'), track('b', 'Song B')]);
    const music = createMusicCommandService(serviceOpts(bot));
    const stopped = await music.execute(musicIntent({ command: 'stop' }), binding);
    assert.equal(stopped.ok, true);
    assert.deepEqual(bot.queue.getAll().map((item: QueueItem) => item.title), ['Song A', 'Song B']);
  });

  it('reports and sets volume at 0 and 100 and rejects out-of-range values', async () => {
    const bot = fakeBot();
    const applied: number[] = [];
    bot.applyVolume = async (volume: number) => {
      applied.push(volume);
      bot.currentConfig.volume = volume;
    };
    const music = createMusicCommandService(serviceOpts(bot));
    const shown = await music.execute(musicIntent({ command: 'volume' }), binding);
    assert.equal(shown.ok, true);
    assert.match(shown.content, /40%/);
    const zero = await music.execute(musicIntent({ command: 'volume', args: { level: '0' } }), binding);
    const max = await music.execute(musicIntent({ command: 'volume', args: { level: '100' } }), binding);
    const bad = await music.execute(musicIntent({ command: 'volume', args: { level: '101' } }), binding);
    assert.deepEqual(applied, [0, 100]);
    assert.match(zero.content, /0%/);
    assert.match(max.content, /100%/);
    assert.equal(bad.ok, false);
    assert.match(bad.content, /0-100/);
  });

  it('denies restricted controls without mutating playback', async () => {
    const bot = fakeBot('playing');
    bot.nowPlaying = track('cur', 'Current');
    const music = createMusicCommandService(serviceOpts(bot, {
      loadMediaPermissions: async () => restricted,
    }));
    for (const command of ['pause', 'resume', 'skip', 'stop']) {
      const result = await music.execute(musicIntent({ command }), binding);
      assert.equal(result.code, 'unauthorized', command);
    }
    const volume = await music.execute(musicIntent({ command: 'volume', args: { level: '10' } }), binding);
    assert.equal(volume.code, 'unauthorized');
    assert.equal(bot.status, 'playing');
    assert.equal(bot.nowPlaying?.title, 'Current');
    assert.equal(bot.currentConfig.volume, 40);
  });

  it('rejects unpaired guilds and missing bots before controls run', async () => {
    const bot = fakeBot('playing');
    let gets = 0;
    const music = createMusicCommandService(serviceOpts(bot, {
      getBot: () => { gets += 1; return bot; },
    }));
    const unpaired = await music.execute(musicIntent({ command: 'pause' }), null);
    const missing = await createMusicCommandService(serviceOpts(bot, { getBot: () => null }))
      .execute(musicIntent({ command: 'skip' }), binding);
    assert.equal(unpaired.code, 'unpaired');
    assert.equal(missing.code, 'unavailable');
    assert.equal(gets, 0);
    assert.equal(bot.status, 'playing');
  });

  it('does not skip twice for the same Discord interaction', async () => {
    const bot = fakeBot('playing');
    bot.queue.addMany([track('a', 'One'), track('b', 'Two'), track('c', 'Three')]);
    bot.queue.playAt(0);
    bot.nowPlaying = bot.queue.current;
    const music = createMusicCommandService(serviceOpts(bot));
    const intent = musicIntent({ command: 'skip', idempotencyKey: 'skip-retry' });
    const first = await music.execute(intent, binding);
    const second = await music.execute(intent, binding);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(bot.nowPlaying?.title, 'Two');
    assert.match(second.content, /Already handled/);
  });

  it('uses the bound bot id, never a client-supplied bot id', async () => {
    const bot = fakeBot('playing');
    bot.nowPlaying = track('cur', 'Current');
    const adapter = createDiscordCommandAdapter(adapterDeps(bot));
    const result = await adapter.handle(musicIntent({
      command: 'pause',
      args: { botId: '99' },
      userId: DJ,
    }));
    assert.equal(result.ok, true);
    assert.equal(bot.status, 'paused');
  });
});
