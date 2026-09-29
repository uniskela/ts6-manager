import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { musicBotRoutes } from './music-bots.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { MediaSessionConflictError } from '../voice/media-session.js';

const VIDEO = {
  id: '11111111-1111-4111-8111-111111111111', kind: 'video' as const, state: 'active' as const,
  botId: 3, botName: 'Cinema', startedAt: 0, label: 'iptv.example',
};

function buildApp(locals: Record<string, unknown>): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role: 'admin', username: 'tester' };
    Object.assign(req.app.locals, locals);
    next();
  });
  app.use('/api/music-bots', musicBotRoutes);
  app.use(errorHandler);
  return app;
}

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('music routes keep the media-session conflict contract', () => {
  it('play-url answers 409 with the conflicts instead of a generic 500', async () => {
    const bot = {
      status: 'connected',
      assertMusicCanStart: () => { throw new MediaSessionConflictError('music', [VIDEO]); },
    };
    const app = buildApp({ voiceBotManager: { getBot: () => bot } });
    const res = await post(app, '/api/music-bots/3/play-url', { url: 'https://example.com/a.mp3' });
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'media_session_conflict');
    assert.equal(res.body.conflicts[0].id, VIDEO.id);
  });

  it('queueing a playlist without autoplay never asks to replace the stream', async () => {
    let asserted = 0;
    const added: unknown[] = [];
    const bot = {
      status: 'connected',
      queue: { addMany: (items: unknown[]) => added.push(...items), length: 1, clear: () => {} },
      assertMusicCanStart: () => { asserted++; throw new MediaSessionConflictError('music', [VIDEO]); },
    };
    const prisma = {
      playlist: {
        findUnique: async () => ({
          id: 5,
          songs: [{ song: { id: 9, title: 'x', filePath: '/a.mp3', source: 'local' } }],
        }),
      },
    };
    const app = buildApp({ voiceBotManager: { getBot: () => bot }, prisma });
    const queued = await post(app, '/api/music-bots/3/queue/playlist', { playlistId: 5 });
    assert.equal(queued.status, 200);
    assert.equal(asserted, 0);
    assert.equal(added.length, 1);

    const autoplay = await post(app, '/api/music-bots/3/queue/playlist', { playlistId: 5, autoplay: true });
    assert.equal(autoplay.status, 409);
    assert.equal(added.length, 1, 'an unconfirmed autoplay must not change the queue');
  });
});
