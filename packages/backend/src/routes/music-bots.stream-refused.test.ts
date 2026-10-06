import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { musicBotRoutes } from './music-bots.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import {
  VideoSourceFailedError,
  VideoSourceRefusedError,
  durationFilterSkipMessage,
} from '../voice/streaming/video-download.js';
import { AppError } from '../middleware/error-handler.js';

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
    assert.equal(res.body.reason, 'source_refused');
    assert.match(res.body.error, /Stream YouTube videos directly/);
  });

  it('passes a yt-dlp failure through as 502 with its reason', async () => {
    const reason = 'yt-dlp info failed: Sign in to confirm you are not a bot';
    const res = await startStream(buildApp(async () => { throw new VideoSourceFailedError(reason); }));
    assert.equal(res.status, 502);
    assert.equal(res.body.error, reason);
    assert.equal(res.body.reason, 'source_unavailable');
  });

  it('answers a source timeout as 504', async () => {
    const reason = 'YouTube URL resolve timed out after 90s';
    const res = await startStream(buildApp(async () => { throw new VideoSourceFailedError(reason); }));
    assert.equal(res.status, 504);
    assert.equal(res.body.reason, 'source_timeout');
  });

  it('keeps unexpected failures generic and secret-free', async () => {
    const res = await startStream(buildApp(async () => { throw new Error('database password=secret'); }));
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Something went wrong while starting the stream');
    assert.equal(res.body.reason, 'unexpected_error');
    assert.equal(JSON.stringify(res.body).includes('password=secret'), false);
  });

  it('returns 200 alreadyRunning for an idempotent duplicate start', async () => {
    const res = await startStream(buildApp(async () => ({ alreadyRunning: true, replaced: [] })));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.alreadyRunning, true);
  });

  it('returns 409 stream_already_running instead of a generic 500', async () => {
    const res = await startStream(buildApp(async () => {
      throw new AppError(
        409,
        'A video is already streaming',
        'amf-test.mp4 is already playing on this bot. Stop the current stream or use Switch source.',
        { reason: 'stream_already_running' },
      );
    }));
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'stream_already_running');
    assert.match(res.body.details, /Switch source/);
  });

  it('returns 400 for a missing source', async () => {
    const app = buildApp(async () => ({ alreadyRunning: false, replaced: [] }));
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/music-bots/3/stream/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json() as any;
      assert.equal(res.status, 400);
      assert.equal(body.reason, 'source_invalid');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
