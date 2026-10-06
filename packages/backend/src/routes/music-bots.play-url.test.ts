import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type Express } from 'express';
import { AppError, errorHandler } from '../middleware/error-handler.js';
import { createPlayUrlHandler } from './music-bots.routes.js';
import type { MediaUrlPipelineDeps } from '../voice/media-url-pipeline.js';

function deps(overrides: Partial<MediaUrlPipelineDeps> = {}): MediaUrlPipelineDeps {
  return {
    resolveSpotify: async (url) => url,
    resolveAppleMusic: async () => ({ tracks: [] }),
    appleTrackToYouTube: async () => null,
    expandYouTube: async () => null,
    downloadTrack: async (url) => ({
      id: url, title: 'Track', artist: 'Artist', duration: 1, filePath: '/tmp/track.opus',
      source: 'youtube' as const, sourceUrl: url,
    }),
    ...overrides,
  };
}

function buildApp(pipelineDeps: MediaUrlPipelineDeps): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role: 'admin', username: 'tester' };
    req.app.locals.voiceBotManager = {
      getBot: () => ({
        id: 3,
        status: 'connected',
        assertMusicCanStart: () => {},
        currentConfig: { id: 3, serverConfigId: null },
        queue: { add: () => {}, playAt: () => {} },
      }),
    };
    req.app.locals.prisma = {};
    next();
  });
  app.post('/api/music-bots/:id/play-url', createPlayUrlHandler(pipelineDeps));
  app.use(errorHandler);
  return app;
}

async function post(app: Express, body: unknown) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/music-bots/3/play-url`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('play-url keeps resolution failures at 502', async () => {
  const response = await post(buildApp(deps({
    expandYouTube: async () => ({ urls: [] }),
  })), { url: 'https://www.youtube.com/playlist?list=empty' });
  assert.equal(response.status, 502);
  assert.equal(response.body.error, 'Could not resolve any videos from that playlist URL');
});

test('play-url maps unexpected failures to a generic 500', async () => {
  const response = await post(buildApp(deps({
    downloadTrack: async () => { throw new Error('yt-dlp failed'); },
  })), { url: 'https://www.youtube.com/watch?v=00000000001' });
  assert.equal(response.status, 500);
  assert.equal(response.body.reason, 'unexpected_error');
  assert.equal(response.body.error, 'Something went wrong');
  assert.equal(JSON.stringify(response.body).includes('yt-dlp failed'), false);
});

test('play-url passes through status-bearing errors', async () => {
  const response = await post(buildApp(deps({
    downloadTrack: async () => { throw new AppError(409, 'A media session is active'); },
  })), { url: 'https://www.youtube.com/watch?v=00000000001' });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'A media session is active');
});

test('play-url rethrows arbitrary errors carrying a numeric statusCode', async () => {
  const error = Object.assign(new Error('A media session is active'), { statusCode: 409 });
  const bot = {
    id: 3, status: 'connected', assertMusicCanStart: () => {},
    currentConfig: { id: 3, serverConfigId: null }, queue: { add: () => {}, playAt: () => {} },
  };
  const req = {
    params: { id: '3' }, body: { url: 'https://www.youtube.com/watch?v=00000000001' },
    user: { id: 1, role: 'admin', username: 'tester' },
    app: { locals: { voiceBotManager: { getBot: () => bot }, prisma: {} } },
  } as any;
  const res = { json: () => {} } as any;
  let forwarded: unknown;
  await createPlayUrlHandler(deps({ downloadTrack: async () => { throw error; } }))(req, res, (err) => {
    forwarded = err;
  });
  assert.equal(forwarded, error);
});
