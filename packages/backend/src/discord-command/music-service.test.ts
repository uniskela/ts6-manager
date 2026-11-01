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
    stopGeneration: 0,
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
      if (!options?.keepPendingRequests) bot.stopGeneration += 1;
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

  it('fails closed when playlist catalog is not wired', async () => {
    const adapter = createDiscordCommandAdapter(adapterDeps(fakeBot()));
    const result = await adapter.handle(musicIntent({ command: 'playlist', args: { subcommand: 'list' }, userId: DJ }));
    assert.equal(result.code, 'unavailable');
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

function songRow(id: number, title: string, serverConfigId = 9) {
  return {
    id, title, artist: 'A', duration: 1, filePath: `/tmp/${id}`, source: 'url',
    sourceUrl: `https://8.8.8.8/${id}`, serverConfigId,
  };
}

function fakeCatalog() {
  let nextPlaylist = 20;
  let nextSong = 200;
  const playlists: Array<{ id: number; name: string; serverConfigId: number | null; musicBotId?: number }> = [
    { id: 3, name: 'Rock', serverConfigId: 9, musicBotId: 1 },
    { id: 4, name: 'Shared Mix', serverConfigId: null },
    { id: 5, name: 'Other Server', serverConfigId: 8 },
    { id: 6, name: 'Rock Live', serverConfigId: 9 },
  ];
  const songs = [songRow(7, 'Track'), songRow(8, 'Shared Song'), songRow(9, 'Foreign Song', 8)];
  const links = [
    { playlistId: 3, songId: 7, position: 0 },
    { playlistId: 4, songId: 8, position: 0 },
    { playlistId: 5, songId: 9, position: 0 },
  ];
  const stations = [
    { id: 1, name: 'Jazz FM', url: 'https://8.8.8.8/jazz', genre: 'Jazz', serverConfigId: 9 },
    { id: 2, name: 'Rock Radio', url: 'https://8.8.8.8/rock', genre: 'Rock', serverConfigId: 9 },
    { id: 11, name: 'Foreign FM', url: 'https://8.8.8.8/f', genre: 'X', serverConfigId: 8 },
  ];

  function inScope(row: { id?: number; serverConfigId?: number | null }, where: any): boolean {
    if (!where) return true;
    if (where.id != null && row.id !== where.id) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'serverConfigId') && where.OR == null && row.serverConfigId !== where.serverConfigId) {
      return false;
    }
    if (where.OR) return where.OR.some((clause: any) => inScope(row, { ...where, ...clause, OR: undefined }));
    return true;
  }

  const db: any = {
    playlist: {
      findMany: async ({ where }: any) => playlists.filter((p) => inScope(p, where)).map(({ id, name }) => ({ id, name })),
      findFirst: async ({ where }: any) => {
        const playlist = playlists.find((p) => inScope(p, where));
        if (!playlist) return null;
        return {
          ...playlist,
          songs: links.filter((link) => link.playlistId === playlist.id)
            .sort((a, b) => a.position - b.position)
            .map((link) => ({ position: link.position, song: songs.find((s) => s.id === link.songId) })),
        };
      },
      create: async ({ data }: any) => {
        const created = { id: nextPlaylist++, name: data.name, serverConfigId: data.serverConfigId, musicBotId: data.musicBotId };
        playlists.push(created);
        return created;
      },
    },
    radioStation: {
      findMany: async ({ where }: any) => stations.filter((s) => s.serverConfigId === where.serverConfigId),
    },
    song: {
      findFirst: async ({ where }: any) => songs.find((s) => s.sourceUrl === where.sourceUrl && s.serverConfigId === where.serverConfigId) ?? null,
      create: async ({ data }: any) => {
        const created = { id: nextSong++, ...data };
        songs.push(created);
        return created;
      },
    },
    playlistSong: {
      findUnique: async ({ where }: any) => {
        const key = where.playlistId_songId;
        return links.find((link) => link.playlistId === key.playlistId && link.songId === key.songId) ?? null;
      },
      create: async ({ data }: any) => { links.push(data); return data; },
      deleteMany: async ({ where }: any) => {
        const before = links.length;
        for (let i = links.length - 1; i >= 0; i--) {
          if (links[i].playlistId === where.playlistId && links[i].songId === where.songId) links.splice(i, 1);
        }
        return { count: before - links.length };
      },
      aggregate: async ({ where }: any) => {
        const positions = links.filter((link) => link.playlistId === where.playlistId).map((link) => link.position);
        return { _max: { position: positions.length ? Math.max(...positions) : null } };
      },
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
    _playlists: playlists,
    _links: links,
    _songs: songs,
  };
  return db;
}

describe('Discord playlist and radio catalog (2B-2A)', () => {
  const binding = { instanceId: 'inst-1', revoked: false, botId: 1 };

  it('lists this server and shared playlists, not other servers', async () => {
    const music = createMusicCommandService(serviceOpts(fakeBot(), { prisma: fakeCatalog() }));
    const result = await music.execute(musicIntent({ command: 'playlist', args: { subcommand: 'list' } }), binding);
    assert.equal(result.ok, true);
    assert.match(result.content, /Rock/);
    assert.match(result.content, /Shared Mix/);
    assert.doesNotMatch(result.content, /Other Server/);
  });

  it('plays a saved playlist onto the shared queue', async () => {
    const bot = fakeBot();
    const music = createMusicCommandService(serviceOpts(bot, { prisma: fakeCatalog() }));
    const result = await music.execute(musicIntent({
      command: 'playlist',
      args: { subcommand: 'play', name: 'Rock' },
    }), binding);
    assert.equal(result.ok, true);
    assert.equal(result.ack, 'deferred');
    assert.equal(bot.nowPlaying?.title, 'Track');
    assert.equal(bot.queue.length, 1);
  });

  it('requires an unambiguous playlist or station name', async () => {
    const music = createMusicCommandService(serviceOpts(fakeBot(), { prisma: fakeCatalog() }));
    const playlist = await music.execute(musicIntent({
      command: 'playlist', args: { subcommand: 'play', name: 'Rock' },
    }), binding);
    assert.equal(playlist.ok, true);
    const ambiguous = await music.execute(musicIntent({
      command: 'playlist', args: { subcommand: 'play', name: 'roc' },
    }), binding);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.content, /Ambiguous/);
  });

  it('lists and plays radio on this server only', async () => {
    const bot = fakeBot();
    const music = createMusicCommandService(serviceOpts(bot, { prisma: fakeCatalog() }));
    const list = await music.execute(musicIntent({ command: 'radio', args: { subcommand: 'list' } }), binding);
    assert.match(list.content, /Jazz FM/);
    assert.match(list.content, /\/radio play/);
    assert.doesNotMatch(list.content, /!radio/);
    assert.doesNotMatch(list.content, /Foreign FM/);
    const play = await music.execute(musicIntent({
      command: 'radio', args: { subcommand: 'play', station: 'Jazz FM' },
    }), binding);
    assert.equal(play.ok, true);
    assert.equal(bot.nowPlaying?.title, 'Jazz FM');
    assert.equal(bot.nowPlaying?.source, 'radio');
  });

  it('does not enqueue a playlist loaded after /stop', async () => {
    const bot = fakeBot();
    const catalog = fakeCatalog();
    const original = catalog.playlist.findFirst;
    catalog.playlist.findFirst = async (args: unknown) => {
      bot.stopGeneration += 1;
      return original(args);
    };
    const music = createMusicCommandService(serviceOpts(bot, { prisma: catalog }));
    const result = await music.execute(musicIntent({
      command: 'playlist', args: { subcommand: 'play', name: '3' },
    }), binding);
    assert.equal(result.ok, false);
    assert.match(result.content, /stopped/);
    assert.equal(bot.queue.length, 0);
  });

  it('denies playlist play without queue permission and radio play without playback permission', async () => {
    const bot = fakeBot();
    const music = createMusicCommandService(serviceOpts(bot, {
      prisma: fakeCatalog(),
      loadMediaPermissions: async () => restricted,
    }));
    const playlist = await music.execute(musicIntent({
      command: 'playlist', args: { subcommand: 'play', name: 'Rock' },
    }), binding);
    const radio = await music.execute(musicIntent({
      command: 'radio', args: { subcommand: 'play', station: '1' },
    }), binding);
    const list = await music.execute(musicIntent({ command: 'playlist', args: { subcommand: 'list' } }), binding);
    assert.equal(playlist.code, 'unauthorized');
    assert.equal(radio.code, 'unauthorized');
    assert.equal(list.ok, true);
    assert.equal(bot.nowPlaying, null);
  });

  it('rejects unpaired guilds and missing bots before catalog access', async () => {
    let finds = 0;
    const catalog = fakeCatalog();
    catalog.playlist.findMany = async () => { finds += 1; return []; };
    const music = createMusicCommandService(serviceOpts(fakeBot(), { prisma: catalog }));
    const unpaired = await music.execute(musicIntent({ command: 'playlist' }), null);
    const missing = await createMusicCommandService(serviceOpts(fakeBot(), { prisma: catalog, getBot: () => null }))
      .execute(musicIntent({ command: 'radio' }), binding);
    assert.equal(unpaired.code, 'unpaired');
    assert.equal(missing.code, 'unavailable');
    assert.equal(finds, 0);
  });

  it('does not play a playlist twice for the same Discord interaction', async () => {
    const bot = fakeBot();
    const music = createMusicCommandService(serviceOpts(bot, { prisma: fakeCatalog() }));
    const intent = musicIntent({
      command: 'playlist',
      args: { subcommand: 'play', name: '3' },
      idempotencyKey: 'pl-retry',
    });
    assert.equal((await music.execute(intent, binding)).ok, true);
    assert.equal((await music.execute(intent, binding)).ok, true);
    assert.equal(bot.queue.length, 1);
  });
});

describe('Discord playlist edits (2B-2B)', () => {
  const binding = { instanceId: 'inst-1', revoked: false, botId: 1 };

  it('lets TS6 admins create, add, and remove tracks with stable order', async () => {
    const catalog = fakeCatalog();
    const music = createMusicCommandService(serviceOpts(fakeBot(), { prisma: catalog }));
    const created = await music.execute(musicIntent({
      command: 'playlist',
      ts6Role: 'admin',
      args: { subcommand: 'create', name: 'Night' },
    }), binding);
    assert.equal(created.ok, true);
    const add = await music.execute(musicIntent({
      command: 'playlist',
      ts6Role: 'admin',
      args: { subcommand: 'add', name: 'Night', url: 'https://8.8.8.8/night.mp3' },
    }), binding);
    assert.equal(add.ok, true);
    const playlist = await catalog.playlist.findFirst({ where: { OR: [{ serverConfigId: 9 }, { serverConfigId: null }], id: 20 } });
    assert.equal(playlist.songs.length, 1);
    assert.equal(playlist.songs[0].position, 0);
    const removed = await music.execute(musicIntent({
      command: 'playlist',
      ts6Role: 'admin',
      args: { subcommand: 'remove', name: 'Night', track: '1' },
    }), binding);
    assert.equal(removed.ok, true);
    const empty = await catalog.playlist.findFirst({ where: { OR: [{ serverConfigId: 9 }, { serverConfigId: null }], id: 20 } });
    assert.equal(empty.songs.length, 0);
  });

  it('does not treat Discord Manage Guild as playlist-edit admin', async () => {
    const bot = fakeBot();
    const adapter = createDiscordCommandAdapter({
      ...adapterDeps(bot, { music: createMusicCommandService(serviceOpts(bot, { prisma: fakeCatalog() })) }),
      policy: { viewerRoleIds: [VIEWER_ROLE], adminRoleIds: [] },
    });
    const result = await adapter.handle(musicIntent({
      command: 'playlist',
      args: { subcommand: 'create', name: 'Nope' },
      userId: VIEWER,
      roleIds: [VIEWER_ROLE],
      memberPermissions: String(1n << 5n),
    }));
    assert.equal(result.code, 'unauthorized');
  });

  it('keeps playlist edits admin-only even when DJs can play', async () => {
    const catalog = fakeCatalog();
    const music = createMusicCommandService(serviceOpts(fakeBot(), { prisma: catalog }));
    const denied = await music.execute(musicIntent({
      command: 'playlist',
      ts6Role: 'viewer',
      args: { subcommand: 'create', name: 'Nope' },
    }), binding);
    assert.equal(denied.code, 'unauthorized');
    const play = await music.execute(musicIntent({
      command: 'playlist',
      ts6Role: 'viewer',
      args: { subcommand: 'play', name: 'Rock' },
    }), binding);
    assert.equal(play.ok, true);
  });

  it('does not let Manage Guild or this server edit shared or foreign playlists', async () => {
    const catalog = fakeCatalog();
    const music = createMusicCommandService(serviceOpts(fakeBot(), { prisma: catalog }));
    const shared = await music.execute(musicIntent({
      command: 'playlist',
      ts6Role: 'admin',
      memberPermissions: String(1n << 5n),
      args: { subcommand: 'add', name: '4', url: 'https://8.8.8.8/x.mp3' },
    }), binding);
    const foreign = await music.execute(musicIntent({
      command: 'playlist',
      ts6Role: 'admin',
      args: { subcommand: 'add', name: 'Other Server', url: 'https://8.8.8.8/x.mp3' },
    }), binding);
    assert.equal(shared.ok, false);
    assert.equal(foreign.ok, false);
    assert.match(shared.content, /cannot be edited/);
  });

  it('rejects unsafe add URLs and duplicate interaction edits', async () => {
    const catalog = fakeCatalog();
    let created = 0;
    const originalCreate = catalog.playlist.create;
    catalog.playlist.create = async (args: any) => { created += 1; return originalCreate(args); };
    const music = createMusicCommandService(serviceOpts(fakeBot(), { prisma: catalog }));
    const unsafe = await music.execute(musicIntent({
      command: 'playlist',
      ts6Role: 'admin',
      args: { subcommand: 'add', name: 'Rock', url: 'http://127.0.0.1/secret.mp3' },
    }), binding);
    assert.equal(unsafe.ok, false);
    const intent = musicIntent({
      command: 'playlist',
      ts6Role: 'admin',
      idempotencyKey: 'create-once',
      args: { subcommand: 'create', name: 'Once' },
    });
    assert.equal((await music.execute(intent, binding)).ok, true);
    assert.equal((await music.execute(intent, binding)).ok, true);
    assert.equal(created, 1);
  });
});
