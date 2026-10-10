import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { playlistRoutes } from './playlists.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { MusicCommandHandler } from '../voice/music-command-handler.js';
import { PlayQueue } from '../voice/playlist/queue.js';

async function send(app: Express, path: string) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await response.text();
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const rows = [
  { id: 1, name: 'Server one', mode: 'local', musicBotId: 11, youtubePlaylistId: null, serverConfigId: 1, createdAt: new Date('2026-10-01'), _count: { songs: 1 } },
  { id: 2, name: 'Server two', mode: 'local', musicBotId: 22, youtubePlaylistId: null, serverConfigId: 2, createdAt: new Date('2026-10-02'), _count: { songs: 2 } },
  { id: 3, name: 'Legacy shared', mode: 'local', musicBotId: 22, youtubePlaylistId: null, serverConfigId: null, createdAt: new Date('2026-10-03'), _count: { songs: 3 } },
];

// Apply both top-level AND conditions and OR branches, as Prisma does.
function matchesWhere(row: Record<string, unknown>, where?: any): boolean {
  return !where || Object.entries(where).every(([key, value]) =>
    key === 'OR'
      ? (value as any[]).some((condition) => matchesWhere(row, condition))
      : row[key] === value);
}

function routeFixture() {
  let seenWhere: unknown = 'unset';
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 1, role: 'admin', username: 'tester' };
    next();
  });
  app.locals.prisma = {
    playlist: {
      findMany: async ({ where }: { where?: any }) => {
        seenWhere = where;
        return rows.filter((row) => matchesWhere(row, where));
      },
    },
  };
  app.use('/playlists', playlistRoutes);
  app.use(errorHandler);
  return { app, get seenWhere() { return seenWhere; } };
}

describe('playlist listing scope', () => {
  for (const serverConfigId of [1, 2]) it(`lists server ${serverConfigId} playlists plus legacy shared playlists`, async () => {
    const f = routeFixture();
    const response = await send(f.app, `/playlists?serverConfigId=${serverConfigId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.map((playlist: any) => playlist.id), [serverConfigId, 3]);
    assert.deepEqual(f.seenWhere, { OR: [{ serverConfigId }, { serverConfigId: null }] });
  });

  it('ignores musicBotId when listing playlists', async () => {
    const f = routeFixture();
    const response = await send(f.app, '/playlists?serverConfigId=1&musicBotId=999');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.map((playlist: any) => playlist.id), [1, 3]);
    assert.deepEqual(f.seenWhere, { OR: [{ serverConfigId: 1 }, { serverConfigId: null }] });
  });

  it('returns all playlists without a server parameter', async () => {
    const f = routeFixture();
    const response = await send(f.app, '/playlists');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.map((playlist: any) => playlist.id), [1, 2, 3]);
    assert.equal(f.seenWhere, undefined);
  });

  it('rejects a server parameter that is not a positive whole number', async () => {
    for (const value of ['abc', '0', '-1', '2oops', '1.5', '']) {
      const f = routeFixture();
      const response = await send(f.app, `/playlists?serverConfigId=${value}`);
      assert.equal(response.status, 400, `serverConfigId=${value}`);
      assert.equal(f.seenWhere, 'unset', 'no playlists are listed');
    }
  });

  it('ignores musicBotId without a server parameter', async () => {
    const f = routeFixture();
    const response = await send(f.app, '/playlists?musicBotId=11');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.map((playlist: any) => playlist.id), [1, 2, 3]);
    assert.equal(f.seenWhere, undefined);
  });
});

describe('chat playlist scope', () => {
  for (const serverConfigId of [9, 10]) it(`lists and loads shared and legacy playlists on server ${serverConfigId}`, async () => {
    const replies: string[] = [];
    const playlists = [
      { id: 2, name: 'Server nine other bot', serverConfigId: 9, musicBotId: 99 },
      { id: 3, name: 'Legacy shared', serverConfigId: null, musicBotId: 99 },
      { id: 4, name: 'Server ten other bot', serverConfigId: 10, musicBotId: 100 },
    ];
    const prisma = {
      appSetting: { findUnique: async () => null },
      playlist: {
        findMany: async ({ where }: any) => {
          return playlists.filter((playlist) => matchesWhere(playlist, where));
        },
        findFirst: async ({ where }: any) => {
          const playlist = playlists.find((candidate) => matchesWhere(candidate, where));
          return playlist ? { name: playlist.name, songs: [{ song: {
            id: 7, title: 'Shared track', filePath: '/shared.ogg', source: 'local',
          } }] } : null;
        },
      },
    } as any;
    const handler = new MusicCommandHandler(prisma, {} as any) as any;
    handler.botChannelConfig.set(1, { serverConfigId, virtualServerId: 1 });
    handler.reply = (_bot: unknown, _id: number, message: string) => replies.push(message);
    const bot = {
      currentConfig: { id: 1, serverConfigId },
      ts3ClientId: 42,
      queue: new PlayQueue(),
      status: 'playing',
      nowPlaying: null,
      play: async () => {},
    };

    await handler.onTextMessage(1, bot, { invokerid: '2', msg: '!playlist' });
    const ownName = serverConfigId === 9 ? 'Server nine other bot' : 'Server ten other bot';
    const otherName = serverConfigId === 9 ? 'Server ten other bot' : 'Server nine other bot';
    assert.ok(replies.at(-1)!.includes(ownName));
    assert.match(replies.at(-1)!, /Legacy shared/);
    assert.ok(!replies.at(-1)!.includes(otherName));
    await handler.onTextMessage(1, bot, { invokerid: '2', msg: `!playlist ${ownName}` });
    assert.ok(replies.at(-1)!.includes(`Queued playlist "${ownName}" (1 tracks).`));
    await handler.onTextMessage(1, bot, { invokerid: '2', msg: '!playlist 3' });
    assert.equal(replies.at(-1), 'Queued playlist "Legacy shared" (1 tracks).');
    await handler.onTextMessage(1, bot, { invokerid: '2', msg: '!playlist Legacy shared' });
    assert.equal(replies.at(-1), 'Queued playlist "Legacy shared" (1 tracks).');
    assert.equal(bot.queue.length, 3);
    await handler.onTextMessage(1, bot, { invokerid: '2', msg: `!playlist ${otherName}` });
    assert.equal(replies.at(-1), 'Playlist not found. Use !playlist to list.');
    assert.equal(bot.queue.length, 3);
  });
});

describe('playlist creation scope', () => {
  async function create(body: Record<string, unknown>) {
    let saved: Record<string, unknown> | null = null;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1, role: 'admin', username: 'tester' };
      next();
    });
    app.locals.prisma = {
      playlist: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          saved = data;
          return { id: 9, ...data };
        },
      },
      tsServerConfig: {
        findUnique: async ({ where }: { where: { id: number } }) => ([1, 2].includes(where.id) ? { id: where.id } : null),
      },
    };
    app.use('/playlists', playlistRoutes);
    app.use(errorHandler);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/playlists`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, saved: saved as Record<string, unknown> | null };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('saves the server a playlist was created on', async () => {
    const { status, saved } = await create({ name: 'Lounge', serverConfigId: 2 });
    assert.equal(status, 201);
    assert.equal(saved?.serverConfigId, 2);
  });

  it('keeps a playlist created without a server shared', async () => {
    const { status, saved } = await create({ name: 'Lounge' });
    assert.equal(status, 201);
    assert.equal(saved?.serverConfigId, null);
  });

  it('rejects a server that does not exist', async () => {
    const { status, saved } = await create({ name: 'Lounge', serverConfigId: 99 });
    assert.equal(status, 400);
    assert.equal(saved, null);
  });

  it('rejects a server that is not a positive whole number', async () => {
    for (const serverConfigId of ['abc', 0, -1, 1.5]) {
      const { status, saved } = await create({ name: 'Lounge', serverConfigId });
      assert.equal(status, 400, `serverConfigId ${JSON.stringify(serverConfigId)}`);
      assert.equal(saved, null);
    }
  });
});
