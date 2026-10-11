import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import express, { type Express } from 'express';
import { errorHandler, AppError } from '../middleware/error-handler.js';
import { requireServerAccess } from '../middleware/server-access.js';
import { MediaSessionConflictError } from '../voice/media-session.js';
const musicRoot = await mkdtemp(path.join(tmpdir(), 'ts6-replay-'));
const previousMusicDir = process.env.MUSIC_DIR;
process.env.MUSIC_DIR = musicRoot;
const { musicRequestRoutes } = await import('./music-requests.routes.js');
after(async () => {
  if (previousMusicDir === undefined) delete process.env.MUSIC_DIR;
  else process.env.MUSIC_DIR = previousMusicDir;
  await rm(musicRoot, { recursive: true, force: true });
});
import type { MediaUrlPipelineDeps } from '../voice/media-url-pipeline.js';

const storedUrl = 'https://8.8.8.8/watch?v=stored';

function appFor(options: {
  role?: string;
  rows?: Array<Record<string, unknown>>;
  serverConfigId?: number | null;
  allowServerAccess?: boolean;
  conflict?: boolean;
  failHistoryUpdate?: boolean;
  download?: (url: string) => Promise<unknown>;
} = {}): { app: Express; played: string[]; updates: unknown[] } {
  const played: string[] = [];
  const updates: unknown[] = [];
  const rows = options.rows ?? [{
    id: 7, title: 'Display title', url: storedUrl, source: 'youtube', status: 'available',
    serverConfigId: 1, musicBotId: 3, requestedAt: new Date('2026-10-10T00:00:00.000Z'),
  }];
  const deps: MediaUrlPipelineDeps = {
    resolveSpotify: async (url) => url,
    resolveAppleMusic: async () => ({ tracks: [] }),
    resolveSpotifyCollection: async () => null,
    appleTrackToYouTube: async () => null,
    expandYouTube: async () => null,
    downloadTrack: async (url) => options.download?.(url) ?? ({
      id: url, title: 'Track', artist: 'Artist', duration: 1, filePath: '/tmp/track.opus',
      source: 'youtube' as const, sourceUrl: url,
    }),
  };
  const bot = {
    id: 3, status: 'connected', assertMusicCanStart: (ids: string[]) => {
      if (options.conflict && !ids?.includes('11111111-1111-4111-8111-111111111111')) throw new MediaSessionConflictError('music', [{
        id: '11111111-1111-4111-8111-111111111111', kind: 'video', state: 'active', botId: 3, botName: 'Cinema', startedAt: 0,
      }]);
    },
    currentConfig: { id: 3, serverConfigId: options.serverConfigId === undefined ? 1 : options.serverConfigId },
    queue: { add: () => {}, playAt: () => {}, length: 0 },
    play: async (item: { filePath: string }) => { played.push(item.filePath); },
    playStream: async () => {},
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role: options.role ?? 'admin', username: 'tester' };
    req.app.locals.mediaUrlPipelineDeps = deps;
    req.app.locals.voiceBotManager = {
      on: () => {},
      off: () => {},
      getBot: () => bot,
    };
    req.app.locals.prisma = {
      musicRequest: {
        findMany: async ({ skip, select, where }: any) => {
          const filtered = rows.filter(row => row.serverConfigId === where.serverConfigId
            && (where.musicBotId === undefined || row.musicBotId === where.musicBotId)
            && (!where.OR || where.OR.some((item: any) => item.musicBotId === row.musicBotId)));
          if (skip != null) return filtered.slice(skip);
          return filtered.map(row => Object.fromEntries(Object.keys(select).map(key => [key, row[key] ?? null])));
        },
        findFirst: async ({ where }: { where: { id: number; serverConfigId: number } }) =>
          rows.find((row) => row.id === where.id && row.serverConfigId === where.serverConfigId) ?? null,
        update: async (args: unknown) => { if (options.failHistoryUpdate) throw new AppError(503, 'History storage unavailable'); updates.push(args); },
        upsert: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
      },
      userServerAccess: { findUnique: async () => options.allowServerAccess ? { userId: 1, serverConfigId: 1 } : null },
      adminAuditEvent: { create: async () => ({ id: 'audit' }), updateMany: async () => ({ count: 1 }) },
    };
    next();
  });
  app.use('/api/servers/:configId/music-requests', requireServerAccess(), musicRequestRoutes);
  app.use(errorHandler);
  return { app, played, updates };
}

async function request(app: Express, method: string, url: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('history lists source, time and status and replays the stored URL', async () => {
  const seen: string[] = [];
  const { app } = appFor({
    download: async (url) => {
      seen.push(url);
      return {
        id: url, title: 'Track', artist: 'Artist', duration: 1, filePath: '/tmp/track.opus',
        source: 'youtube' as const, sourceUrl: url,
      };
    },
  });
  const listed = await request(app, 'GET', '/api/servers/1/music-requests?botId=3');
  assert.equal(listed.status, 200);
  assert.equal(listed.body[0].title, 'Display title');
  assert.equal(listed.body[0].source, 'youtube');
  assert.equal(listed.body[0].status, 'available');
  assert.equal('url' in listed.body[0], false);
  assert.equal('serverConfigId' in listed.body[0], false);
  assert.ok(listed.body[0].requestedAt);

  const played = await request(app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3, enqueue: true });
  assert.equal(played.status, 200);
  assert.deepEqual(seen, [storedUrl]);
  assert.equal(JSON.stringify(seen).includes('Display title'), false);
});

test('replay follows admin media permissions and marks removed media unavailable', async () => {
  const denied = appFor({ role: 'viewer' });
  const forbidden = await request(denied.app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3 });
  assert.equal(forbidden.status, 403);

  const root = musicRoot;
  try {
    const missing = appFor({
      rows: [{ id: 7, title: 'Local', url: 'gone.mp3', source: 'local', status: 'available', serverConfigId: 1, musicBotId: 3 }],
    });
    const gone = await request(missing.app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3 });
    assert.equal(gone.status, 410);
    assert.equal(gone.body.error, 'This media is no longer available.');
    assert.deepEqual(missing.updates, [{ where: { id: 7 }, data: { status: 'unavailable' } }]);

    await writeFile(path.join(root, 'kept.mp3'), 'audio');
    const present = appFor({
      rows: [{ id: 8, title: 'Local', url: 'kept.mp3', source: 'local', status: 'available', serverConfigId: 1, musicBotId: 3 }],
    });
    const ok = await request(present.app, 'POST', '/api/servers/1/music-requests/8/replay', { botId: 3 });
    assert.equal(ok.status, 200);
    assert.equal(present.played.length, 1);
    assert.equal(present.played[0].endsWith('kept.mp3'), true);
  } finally {
    await rm(path.join(root, 'kept.mp3'), { force: true });
  }
});


test('history enforces connection access, scopes bots and rejects malformed IDs', async () => {
  const viewer = appFor({ role: 'viewer' });
  assert.equal((await request(viewer.app, 'GET', '/api/servers/1/music-requests')).status, 403);
  const permitted = appFor({ role: 'viewer', allowServerAccess: true, rows: [
    { id: 1, title: 'Selected', url: 'secret', serverConfigId: 1, musicBotId: 3 },
    { id: 2, title: 'Legacy', url: 'secret', serverConfigId: 1, musicBotId: 0 },
    { id: 3, title: 'Other bot', url: 'secret', serverConfigId: 1, musicBotId: 4 },
    { id: 4, title: 'Other connection', url: 'secret', serverConfigId: 2, musicBotId: 3 },
  ] });
  const listed = await request(permitted.app, 'GET', '/api/servers/1/music-requests?botId=3');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((row: any) => row.title), ['Selected', 'Legacy']);
  assert.equal(JSON.stringify(listed.body).includes('secret'), false);
  const { app } = appFor();
  for (const id of ['3oops', '-1', '0', '3&botId=4']) {
    assert.equal((await request(app, 'GET', `/api/servers/1/music-requests?botId=${id}`)).status, 400);
  }
  for (const botId of ['3oops', '3', true, -1, 0]) {
    assert.equal((await request(app, 'POST', '/api/servers/1/music-requests/7/replay', { botId })).status, 400);
  }
  assert.equal((await request(app, 'POST', '/api/servers/2/music-requests/7/replay', { botId: 3 })).status, 404);
  assert.equal((await request(app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3, enqueue: 'true' })).status, 400);
  assert.equal((await request(appFor({ serverConfigId: 2 }).app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3 })).status, 404);
});

test('deleted remote sources fail cleanly and history-write failures reach the error handler', async () => {
  const missing = appFor({ download: async () => { throw new Error('yt-dlp info failed: Video unavailable. This video was removed'); } });
  const gone = await request(missing.app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3, enqueue: true });
  assert.equal(gone.status, 410);
  assert.equal(gone.body.error, 'This media is no longer available.');
  assert.equal(missing.updates.length, 1);
  const brokenHistory = appFor({ failHistoryUpdate: true, download: async () => { throw new Error('HTTP Error 404: Not Found'); } });
  const failed = await request(brokenHistory.app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3, enqueue: true });
  assert.equal(failed.status, 503);
});

test('replay preserves explicit media-session replacement and permits enqueue without replacement', async () => {
  const { app, played } = appFor({ conflict: true });
  const conflict = await request(app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.reason, 'media_session_conflict');
  assert.equal(played.length, 0);
  assert.equal((await request(app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3, enqueue: true })).status, 200);
  assert.equal(played.length, 0);
  assert.equal((await request(app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3, replaceSessionIds: ['11111111-1111-4111-8111-111111111111'] })).status, 200);
  assert.equal(played.length, 1);
});

test('temporary resolver failures keep the stored source available for retry', async () => {
  const { app, updates } = appFor({ download: async () => { throw new AppError(502, 'Temporary resolver failure'); } });
  const result = await request(app, 'POST', '/api/servers/1/music-requests/7/replay', { botId: 3, enqueue: true });
  assert.equal(result.status, 502);
  assert.deepEqual(updates, []);
});
