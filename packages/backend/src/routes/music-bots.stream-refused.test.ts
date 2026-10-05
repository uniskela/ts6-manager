import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { musicBotRoutes } from './music-bots.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import {
  VideoSourceRefusedError,
  durationFilterSkipMessage,
} from '../voice/streaming/video-download.js';

function buildApp(startVideoStream: () => Promise<unknown>): Express {
  const bot = {
    id: 3,
    status: 'connected',
    currentConfig: { id: 3, serverConfigId: null, volume: 50 },
    videoStreamStatus: null,
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role: 'admin', username: 'tester' };
    Object.assign(req.app.locals, {
      voiceBotManager: {
        getBot: () => bot,
        assertVideoCanStart: () => [],
        startVideoStream,
        on: () => {},
        off: () => {},
      },
      prisma: { adminAuditEvent: { create: async () => ({}) } },
    });
    next();
  });
  app.use('/api/music-bots', musicBotRoutes);
  app.use(errorHandler);
  return app;
}

async function startStream(app: Express) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/music-bots/3/stream/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'https://www.youtube.com/watch?v=00000000001' }),
    });
    return { status: res.status, body: await res.json() as any };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('stream/start with direct YouTube streaming off', () => {
  it('answers a too-long video with the refusal that names the switch, not a 500', async () => {
    const skipped = '[youtube] x: Downloading webpage\n[download] Eight hours does not pass filter (duration <= 900), skipping ..\n';
    const message = durationFilterSkipMessage(skipped, 900);
    assert.ok(message);
    const res = await startStream(buildApp(async () => { throw new VideoSourceRefusedError(message); }));
    assert.equal(res.status, 422);
    assert.equal(res.body.error, message);
    assert.match(res.body.error, /Stream YouTube videos directly/);
  });

  it('keeps unexpected failures generic', async () => {
    const res = await startStream(buildApp(async () => { throw new Error('boom'); }));
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Internal server error');
  });
});
