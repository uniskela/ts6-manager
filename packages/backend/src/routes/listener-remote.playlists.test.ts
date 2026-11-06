import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import express from 'express';
import { listenerRemoteRoutes, listenerRemoteIpGuard } from './listener-remote.routes.js';
import { ListenerRemoteService } from '../voice/listener-remote.js';
import { defaultMediaCommandPermissions } from '../voice/media-command-permissions.js';
import { PlayQueue, type QueueItem } from '../voice/playlist/queue.js';

const binding = { botId: 4, serverConfigId: 2, virtualServerId: 3, channelId: 8, clid: 9, uid: 'listener-secret-identity' };
const item: QueueItem = {
  id: 'song-11', title: 'Visible title', artist: 'Visible artist', duration: 123,
  filePath: '/private/music/credential.mp3', source: 'url', sourceUrl: 'https://8.8.8.8/media',
};

type PlaylistRow = {
  id: number;
  name: string;
  remoteAccess: 'hidden' | 'browse' | 'request';
  serverConfigId: number | null;
  songs: Array<{
    id: number;
    position: number;
    song: {
      id: number;
      title: string;
      artist: string | null;
      duration: number | null;
      filePath: string;
      source: string;
      sourceUrl: string | null;
      mode?: string;
      youtubePlaylistId?: string | null;
      musicBotId?: number | null;
      serverConfigId: number;
    };
  }>;
};

function matchesVisible(row: PlaylistRow, where: Record<string, unknown>): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  const access = where.remoteAccess as { in: string[] } | undefined;
  if (access && !access.in.includes(row.remoteAccess)) return false;
  const or = where.OR as Array<{ serverConfigId: number | null }> | undefined;
  if (or && !or.some(clause => clause.serverConfigId === row.serverConfigId)) return false;
  const name = where.name as { contains: string } | undefined;
  if (name && !row.name.includes(name.contains)) return false;
  return true;
}

function songOnServer(link: PlaylistRow['songs'][number], serverConfigId: number, songWhere: unknown): boolean {
  if (!songWhere || typeof songWhere !== 'object') return link.song.serverConfigId === serverConfigId;
  const nested = (songWhere as { song?: { serverConfigId?: number } }).song;
  if (nested?.serverConfigId !== undefined) return link.song.serverConfigId === nested.serverConfigId;
  return link.song.serverConfigId === serverConfigId;
}

async function fixture() {
  let now = 1_000_000;
  const remote = new ListenerRemoteService(() => now);
  const queue = new PlayQueue();
  queue.add(item);
  const state = {
    uid: binding.uid, channelId: binding.channelId, groups: '7',
    policy: null as string | null, botChannel: binding.channelId,
    botServer: binding.serverConfigId, databaseServer: binding.serverConfigId,
    virtualServer: binding.virtualServerId, botStatus: 'playing',
  };
  const playlistQueries: unknown[] = [];
  const playlistSongQueries: unknown[] = [];
  const playlists = new Map<number, PlaylistRow>();

  const seed = (row: PlaylistRow) => { playlists.set(row.id, row); return row; };

  const bot = {
    currentConfig: { id: binding.botId, serverConfigId: binding.serverConfigId, name: 'Music bot', password: 'bot-secret' },
    ts3ClientId: 99, stopGeneration: 0,
    get status() { return state.botStatus; },
    getCurrentChannelId: () => state.botChannel,
    nowPlaying: item as QueueItem | null, queue,
  };
  Object.defineProperty(bot.currentConfig, 'serverConfigId', { get: () => state.botServer });

  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.locals.listenerRemote = remote;
  app.locals.voiceBotManager = { getBot: () => bot, getBotsForServer: async () => [{ bot }] };
  app.locals.eventBridge = { executeCommand: async (server: number, virtualServer: number, cmd: string) => {
    assert.equal(server, binding.serverConfigId);
    assert.equal(virtualServer, binding.virtualServerId);
    if (cmd.startsWith('clientinfo')) {
      return `client_unique_identifier=${state.uid} client_servergroups=${state.groups} client_type=0\nerror id=0 msg=ok`;
    }
    assert.equal(cmd, 'clientlist -uid');
    return `clid=${binding.clid} cid=${state.channelId} client_unique_identifier=${state.uid} client_type=0\nerror id=0 msg=ok`;
  } };
  app.locals.prisma = {
    appSetting: { findUnique: async () => (state.policy === null ? null : { value: state.policy }) },
    musicBot: { findUnique: async () => ({ serverConfigId: state.databaseServer, virtualServerId: state.virtualServer }) },
    playlist: {
      findMany: async (query: { where: Record<string, unknown>; select?: { songs?: { where?: unknown } }; orderBy?: unknown; skip?: number; take?: number }) => {
        playlistQueries.push(query);
        const serverConfigId = binding.serverConfigId;
        let rows = [...playlists.values()].filter(row => matchesVisible(row, query.where));
        rows.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
        const skip = query.skip ?? 0;
        const take = query.take ?? rows.length;
        rows = rows.slice(skip, skip + take);
        return rows.map(row => ({
          id: row.id,
          name: row.name,
          remoteAccess: row.remoteAccess,
          songs: row.songs
            .filter(link => songOnServer(link, serverConfigId, query.select?.songs?.where))
            .map(link => ({ song: { duration: link.song.duration } })),
        }));
      },
      findFirst: async (query: { where: Record<string, unknown>; select?: { songs?: { where?: unknown } } }) => {
        playlistQueries.push(query);
        const serverConfigId = binding.serverConfigId;
        const row = [...playlists.values()].find(candidate => matchesVisible(candidate, query.where));
        if (!row) return null;
        return {
          id: row.id,
          name: row.name,
          remoteAccess: row.remoteAccess,
          songs: row.songs
            .filter(link => songOnServer(link, serverConfigId, query.select?.songs?.where))
            .map(link => ({ song: { duration: link.song.duration } })),
        };
      },
    },
    playlistSong: {
      findMany: async (query: {
        where: { playlistId: number; song?: { serverConfigId: number } };
        select?: unknown;
        orderBy?: unknown;
        skip?: number;
        take?: number;
      }) => {
        playlistSongQueries.push(query);
        const row = playlists.get(query.where.playlistId);
        if (!row) return [];
        const serverConfigId = query.where.song?.serverConfigId ?? binding.serverConfigId;
        let links = row.songs
          .filter(link => link.song.serverConfigId === serverConfigId)
          .slice()
          .sort((a, b) => a.position - b.position || a.id - b.id);
        const skip = query.skip ?? 0;
        const take = query.take ?? links.length;
        links = links.slice(skip, skip + take);
        return links.map(link => ({
          song: {
            id: link.song.id,
            title: link.song.title,
            artist: link.song.artist,
            duration: link.song.duration,
          },
        }));
      },
    },
  };
  app.use('/api/listener-remote', listenerRemoteIpGuard, listenerRemoteRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/listener-remote`;
  const request = (path: string, options: { session?: string; method?: string } = {}) => fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: options.session ? { Authorization: `Bearer ${options.session}` } : {},
  });
  const exchange = async () => {
    const issued = remote.issue(binding);
    const exchanged = await fetch(`${base}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: issued.token }),
    });
    assert.equal(exchanged.status, 200);
    return await exchanged.json() as { session: string };
  };
  return {
    remote, request, exchange, state, playlists, seed, playlistQueries, playlistSongQueries, bot,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
      server.closeAllConnections();
    }),
  };
}

function restrict(f: Awaited<ReturnType<typeof fixture>>, groups: number[] = []) {
  f.state.policy = JSON.stringify({ ...defaultMediaCommandPermissions(), queue: { mode: 'server_groups', serverGroupIds: groups } });
}

async function using(fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await fn(f); } finally { await f.close(); }
}

function song(
  id: number,
  serverConfigId: number,
  overrides: Partial<PlaylistRow['songs'][number]['song']> = {},
): PlaylistRow['songs'][number]['song'] {
  return {
    id, title: `Song ${id}`, artist: `Artist ${id}`, duration: id * 10,
    filePath: `/secret/${id}.mp3`, source: 'local', sourceUrl: `https://evil.test/${id}`,
    mode: 'local', youtubePlaylistId: `yt-${id}`, musicBotId: 99, serverConfigId, ...overrides,
  };
}

function link(id: number, position: number, track: PlaylistRow['songs'][number]['song']): PlaylistRow['songs'][number] {
  return { id, position, song: track };
}

describe('listener remote shared playlists (A3)', () => {
  it('lists only browse/request playlists for this server or global, with server-scoped counts', async () => using(async f => {
    f.seed({
      id: 1, name: 'Alpha browse', remoteAccess: 'browse', serverConfigId: 2,
      songs: [link(1, 0, song(10, 2)), link(2, 1, song(11, 2, { duration: null })), link(3, 2, song(12, 9))],
    });
    f.seed({
      id: 2, name: 'Beta request', remoteAccess: 'request', serverConfigId: null,
      songs: [link(4, 0, song(20, 2, { duration: 5 })), link(5, 1, song(21, 2, { duration: 7 }))],
    });
    f.seed({
      id: 3, name: 'Hidden here', remoteAccess: 'hidden', serverConfigId: 2,
      songs: [link(6, 0, song(30, 2))],
    });
    f.seed({
      id: 4, name: 'Other server', remoteAccess: 'browse', serverConfigId: 9,
      songs: [link(7, 0, song(40, 9))],
    });
    const { session } = await f.exchange();
    const response = await f.request('/playlists?search=&page=1', { session });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as {
      playlists: Array<{ id: number; name: string; trackCount: number; duration: number | null; wholeRequest: boolean }>;
      page: number;
      pageSize: number;
    };
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 25);
    assert.deepEqual(body.playlists, [
      { id: 1, name: 'Alpha browse', trackCount: 2, duration: null, wholeRequest: false },
      { id: 2, name: 'Beta request', trackCount: 2, duration: 12, wholeRequest: true },
    ]);
    const listed = f.playlistQueries[0] as { where: Record<string, unknown>; orderBy: unknown; skip: number; take: number };
    assert.deepEqual(listed.where.remoteAccess, { in: ['browse', 'request'] });
    assert.deepEqual(listed.where.OR, [{ serverConfigId: 2 }, { serverConfigId: null }]);
    assert.deepEqual(listed.orderBy, [{ name: 'asc' }, { id: 'asc' }]);
    assert.equal(listed.skip, 0);
    assert.equal(listed.take, 25);
  }));

  it('paginates and searches by name contains', async () => using(async f => {
    for (let i = 1; i <= 30; i++) {
      f.seed({
        id: i,
        name: i <= 3 ? `Rock ${i}` : `Jazz ${i}`,
        remoteAccess: 'browse',
        serverConfigId: 2,
        songs: [],
      });
    }
    const { session } = await f.exchange();
    const page2 = await f.request('/playlists?page=2', { session });
    assert.equal(page2.status, 200);
    const page2Body = await page2.json() as { playlists: Array<{ id: number }>; page: number };
    assert.equal(page2Body.page, 2);
    assert.equal(page2Body.playlists.length, 5);
    const search = await f.request('/playlists?search=Rock&page=1', { session });
    assert.equal(search.status, 200);
    const searchBody = await search.json() as { playlists: Array<{ name: string }> };
    assert.deepEqual(searchBody.playlists.map(p => p.name), ['Rock 1', 'Rock 2', 'Rock 3']);
    const listed = f.playlistQueries.at(-1) as { where: { name: { contains: string } }; skip: number };
    assert.deepEqual(listed.where.name, { contains: 'Rock' });
    assert.equal(listed.skip, 0);
  }));

  it('returns allow-listed song fields ordered by position then id', async () => using(async f => {
    f.seed({
      id: 5, name: 'Mixed', remoteAccess: 'browse', serverConfigId: 2,
      songs: [
        link(100, 1, song(2, 2, { title: 'Second', artist: 'B', duration: 20 })),
        link(101, 0, song(1, 2, { title: 'First', artist: null, duration: 10 })),
        link(102, 2, song(3, 9, { title: 'Other server', duration: 99 })),
        link(103, 0, song(4, 2, { title: 'Same position later id', artist: 'C', duration: 40 })),
      ],
    });
    const { session } = await f.exchange();
    const response = await f.request('/playlists/5/songs?page=1', { session });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      playlist: { id: number; trackCount: number; duration: number | null; wholeRequest: boolean };
      songs: Array<Record<string, unknown>>;
      page: number;
      pageSize: number;
    };
    assert.deepEqual(body.playlist, { id: 5, name: 'Mixed', trackCount: 3, duration: 70, wholeRequest: false });
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 25);
    assert.deepEqual(body.songs, [
      { id: 1, title: 'First', artist: null, duration: 10 },
      { id: 4, title: 'Same position later id', artist: 'C', duration: 40 },
      { id: 2, title: 'Second', artist: 'B', duration: 20 },
    ]);
    const serialized = JSON.stringify(body);
    for (const secret of ['/secret/', 'filePath', 'sourceUrl', 'youtubePlaylistId', 'musicBotId', 'evil.test']) {
      assert.ok(!serialized.includes(secret), secret);
    }
    for (const songRow of body.songs) {
      assert.deepEqual(Object.keys(songRow).sort(), ['artist', 'duration', 'id', 'title']);
    }
    const songQuery = f.playlistSongQueries[0] as { orderBy: unknown; where: unknown };
    assert.deepEqual(songQuery.orderBy, [{ position: 'asc' }, { id: 'asc' }]);
    assert.deepEqual(songQuery.where, { playlistId: 5, song: { serverConfigId: 2 } });
  }));

  it('returns byte-identical 404 for hidden, other-server, and missing playlists', async () => using(async f => {
    f.seed({
      id: 10, name: 'Hidden', remoteAccess: 'hidden', serverConfigId: 2,
      songs: [link(1, 0, song(1, 2))],
    });
    f.seed({
      id: 11, name: 'Elsewhere', remoteAccess: 'browse', serverConfigId: 9,
      songs: [link(2, 0, song(2, 9))],
    });
    const { session } = await f.exchange();
    const snapshot = async (path: string) => {
      const response = await f.request(path, { session });
      const body = Buffer.from(await response.arrayBuffer());
      const headers = [...response.headers.entries()]
        .filter(([name]) => !['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(name))
        .sort(([a], [b]) => a.localeCompare(b));
      return { status: response.status, body: body.toString('utf8'), headers };
    };
    const hidden = await snapshot('/playlists/10/songs');
    const other = await snapshot('/playlists/11/songs');
    const missing = await snapshot('/playlists/999/songs');
    assert.equal(hidden.status, 404);
    assert.deepEqual(JSON.parse(hidden.body), { error: 'Playlist not found.', code: 'not_found' });
    assert.deepEqual(hidden, other);
    assert.deepEqual(hidden, missing);
    assert.equal(Buffer.from(hidden.body).equals(Buffer.from(other.body)), true);
    assert.equal(Buffer.from(hidden.body).equals(Buffer.from(missing.body)), true);
  }));

  it('rejects malformed playlist ids and query strings with 400', async () => using(async f => {
    const { session } = await f.exchange();
    for (const path of [
      '/playlists/0/songs',
      '/playlists/-1/songs',
      '/playlists/1.5/songs',
      '/playlists/abc/songs',
      `/playlists/${Number.MAX_SAFE_INTEGER + 1}/songs`,
      '/playlists?page=0',
      '/playlists?page=1.5',
      '/playlists?search=a&search=b',
      '/playlists/1/songs?page=0',
      '/playlists?serverConfigId=999',
    ]) {
      assert.equal((await f.request(path, { session })).status, 400, path);
    }
  }));

  it('keeps browse reads available when queue mutations are restricted, like GET /library', async () => using(async f => {
    f.seed({
      id: 1, name: 'Shareable', remoteAccess: 'browse', serverConfigId: 2, songs: [],
    });
    const { session } = await f.exchange();
    restrict(f, [8]);
    // Read-only queue/info stays open; only add/playlist mutations follow the queue group.
    assert.equal((await f.request('/playlists', { session })).status, 200);
    assert.equal((await f.request('/playlists/1/songs', { session })).status, 200);
    f.state.policy = '{malformed';
    assert.equal((await f.request('/playlists', { session })).status, 200);
    assert.equal((await f.request('/playlists/1/songs', { session })).status, 200);
  }));

  it('returns 401 after revocation or missing credentials', async () => using(async f => {
    f.seed({
      id: 1, name: 'Shareable', remoteAccess: 'browse', serverConfigId: 2, songs: [],
    });
    const { session } = await f.exchange();
    assert.equal((await f.request('/playlists', { session })).status, 200);
    f.remote.revoke(binding.botId, binding.uid);
    assert.equal((await f.request('/playlists', { session })).status, 401);
    assert.equal((await f.request('/playlists/1/songs', { session })).status, 401);
    assert.equal((await f.request('/playlists')).status, 401);
    assert.equal((await f.request('/playlists', { session: 'A'.repeat(43) })).status, 401);
  }));
});
