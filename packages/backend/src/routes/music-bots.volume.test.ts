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

function fixture(apply: (v: number) => Promise<void> = async () => {}) {
  const saved: number[] = [];
  const applied: number[] = [];
  const bot = {
    id: 1,
    currentConfig: { id: 1, serverConfigId: 1, volume: 50 },
    async applyVolume(v: number) {
      applied.push(v);
      this.currentConfig.volume = v;
      await apply(v);
    },
    async setVideoStreamVolume(v: number) { await this.applyVolume(v); },
    async setVideoSource(_source: string, v?: number) {
      if (v != null) this.currentConfig.volume = v;
    },
  };
  const app = buildApp({
    prisma: {
      musicBot: { update: async ({ data }: any) => { saved.push(data.volume); return {}; } },
      adminAuditEvent: {
        create: async () => ({ id: 1 }),
        updateMany: async () => ({ count: 1 }),
      },
    },
    voiceBotManager: { getBot: () => bot, on() {}, off() {} },
  });
  return { app, bot, saved, applied };
}

describe('bot volume routes', () => {
  it('volume 0 mutes instead of falling back to 50', async () => {
    const f = fixture();
    const res = await send(f.app, 'POST', '/api/music-bots/1/volume', { volume: 0 });
    assert.equal(res.status, 200);
    assert.equal(res.body.volume, 0);
    assert.deepEqual(f.applied, [0]);
    assert.deepEqual(f.saved, [0]);
  });

  it('a non-numeric volume is a 400, not a silent 50', async () => {
    const f = fixture();
    const res = await send(f.app, 'POST', '/api/music-bots/1/volume', { volume: 'loud' });
    assert.equal(res.status, 400);
    assert.deepEqual(f.applied, []);
    assert.deepEqual(f.saved, []);
  });

  it('saves the new level even when the stream restart fails', async () => {
    const f = fixture(async () => { throw new Error('sidecar down'); });
    const res = await send(f.app, 'POST', '/api/music-bots/1/volume', { volume: 20 });
    assert.equal(res.status, 500);
    // Music already plays at 20, so a restart must not see the old level.
    assert.deepEqual(f.saved, [20]);
  });

  it('stream volume refuses a non-numeric level with 400', async () => {
    const f = fixture();
    const res = await send(f.app, 'POST', '/api/music-bots/1/stream/volume', { volume: 'abc' });
    assert.equal(res.status, 400);
    assert.deepEqual(f.applied, []);
  });

  it('stream volume saves the level even when the restart fails', async () => {
    const f = fixture(async () => { throw new Error('sidecar down'); });
    const res = await send(f.app, 'POST', '/api/music-bots/1/stream/volume', { volume: 30 });
    assert.equal(res.status, 500);
    assert.deepEqual(f.saved, [30]);
  });

  it('a source change with a volume saves it as the bot volume', async () => {
    const f = fixture();
    const res = await send(f.app, 'POST', '/api/music-bots/1/stream/source', {
      source: 'https://example.com/live.m3u8', volume: '35',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(f.bot.currentConfig.volume, 35);
    assert.deepEqual(f.saved, [35]);
  });
});
