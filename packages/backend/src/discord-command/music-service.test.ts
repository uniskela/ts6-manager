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
    currentConfig: { id: 1, serverConfigId: 9, serverPort: 10011 },
    status,
    nowPlaying: null,
    playbackProgress: { position: 12, duration: 120 },
    queue: new PlayQueue(),
    assertMusicCanStart: () => {},
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

  it('keeps Phase 2B commands unimplemented', async () => {
    const adapter = createDiscordCommandAdapter(adapterDeps(fakeBot()));
    for (const command of ['pause', 'resume', 'skip', 'stop', 'playlist', 'radio', 'volume']) {
      const result = await adapter.handle(musicIntent({ command, userId: DJ }));
      assert.equal(result.code, 'not_implemented', command);
    }
  });
});
