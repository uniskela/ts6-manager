import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { musicBotRoutes } from './music-bots.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

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

async function send(app: Express, method: string, path: string, body: unknown) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// TeamSpeak refuses a nickname outside 3-30 characters (error 1541) at connect,
// so a bot saved with one could never start.
describe('music bot nickname must fit the TeamSpeak limit', () => {
  for (const nickname of ['TS', 'x'.repeat(31), '  ab  ']) {
    it(`create refuses ${JSON.stringify(nickname)}`, async () => {
      let created = 0;
      const app = buildApp({ voiceBotManager: { createBot: async () => { created++; return { id: 1 }; } } });
      const res = await send(app, 'POST', '/api/music-bots', { name: 'Bot', serverConfigId: 1, nickname });
      assert.equal(res.status, 400);
      assert.match(res.body.error ?? res.body.message ?? '', /3.30 characters/);
      assert.equal(created, 0);
    });
  }

  it('create accepts a 3-character nickname', async () => {
    const app = buildApp({ voiceBotManager: { createBot: async () => ({ id: 1 }) } });
    const res = await send(app, 'POST', '/api/music-bots', { name: 'Bot', serverConfigId: 1, nickname: 'TSB' });
    assert.equal(res.status, 201);
  });

  it('update refuses a 2-character nickname before touching the database', async () => {
    let updated = 0;
    const app = buildApp({
      prisma: { musicBot: { update: async () => { updated++; return {}; } } },
      voiceBotManager: { refreshMusicCommandChannels: async () => {}, getBot: () => undefined },
    });
    const res = await send(app, 'PUT', '/api/music-bots/1', { name: 'TS', nickname: 'TS' });
    assert.equal(res.status, 400);
    assert.equal(updated, 0);
  });
});
