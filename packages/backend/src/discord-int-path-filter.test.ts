import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createDiscordInteractionsRouter } from './discord-command/interactions-http.js';
import { authMiddleware } from './middleware/auth.js';
import {
  DISCORD_INTERACTIONS_PATH,
  isAllowedDiscordInteractionsRequest,
  listenDiscordInteractionsPathFilter,
  normalizeFilterPathname,
} from './discord-int-path-filter.js';

/** Generous test limiter so authorization routes are not unthrottled. */
function testRateLimiter() {
  return rateLimit({
    windowMs: 60_000,
    max: 1_000,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
  });
}

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    sign(timestamp: string, body: string) {
      return sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex');
    },
  };
}

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return {
    port: addr.port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

test('path allowlist: only POST /api/discord/interactions', () => {
  assert.equal(isAllowedDiscordInteractionsRequest('POST', DISCORD_INTERACTIONS_PATH), true);
  assert.equal(isAllowedDiscordInteractionsRequest('GET', DISCORD_INTERACTIONS_PATH), false);
  assert.equal(isAllowedDiscordInteractionsRequest('POST', '/api/health'), false);
  assert.equal(isAllowedDiscordInteractionsRequest('POST', '/api/auth/login'), false);
  assert.equal(isAllowedDiscordInteractionsRequest('GET', '/ws'), false);
});

test('normalizeFilterPathname rejects trailing slash and dot-segment tricks', () => {
  assert.equal(normalizeFilterPathname('/api/discord/interactions', '127.0.0.1'), DISCORD_INTERACTIONS_PATH);
  assert.equal(normalizeFilterPathname('/api/discord/interactions/', '127.0.0.1'), null);
  assert.equal(normalizeFilterPathname('/api/discord/../discord/interactions', '127.0.0.1'), DISCORD_INTERACTIONS_PATH);
  assert.equal(normalizeFilterPathname('/api/health', '127.0.0.1'), null);
  assert.equal(normalizeFilterPathname('/api/discord/interactions?x=1', '127.0.0.1'), DISCORD_INTERACTIONS_PATH);
});

test('Discord router mounts before JWT auth — signed PING reaches Ed25519 handler', async () => {
  const keys = ed25519();
  const app = express();
  const limiter = testRateLimiter();
  // Mirror createApp order: Discord first (rate-limited), then global /api JWT.
  app.use(
    DISCORD_INTERACTIONS_PATH,
    limiter,
    createDiscordInteractionsRouter({
      publicKeyHex: keys.publicKeyHex,
      getAdapter: () => null,
      nowMs: () => 1_700_000_000_000,
    }),
  );
  app.use('/api', limiter, authMiddleware);
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  const upstream = await listen(app);
  try {
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';
    const signatureHex = keys.sign(timestamp, body);
    const ping = await fetch(`http://127.0.0.1:${upstream.port}${DISCORD_INTERACTIONS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': signatureHex,
        'x-signature-timestamp': timestamp,
      },
      body,
    });
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { type: 1 });

    const badSig = await fetch(`http://127.0.0.1:${upstream.port}${DISCORD_INTERACTIONS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': 'ab'.repeat(32),
        'x-signature-timestamp': timestamp,
      },
      body,
    });
    assert.equal(badSig.status, 401);

    const missingSig = await fetch(`http://127.0.0.1:${upstream.port}${DISCORD_INTERACTIONS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(missingSig.status, 401);
    const missingJson = await missingSig.json() as { error?: string };
    assert.match(String(missingJson.error), /signature/i);

    // Unrelated API still JWT-protected (not Discord 401 wording).
    const healthAuthedPath = await fetch(`http://127.0.0.1:${upstream.port}/api/servers`);
    assert.equal(healthAuthedPath.status, 401);
    const jwtBody = await healthAuthedPath.json() as { error?: string };
    assert.equal(jwtBody.error, 'No token provided');
  } finally {
    await upstream.close();
  }
});

test('path filter refuses health/auth and forwards signed Discord PING', async () => {
  const keys = ed25519();
  const app = express();
  const limiter = testRateLimiter();
  app.use(
    DISCORD_INTERACTIONS_PATH,
    limiter,
    createDiscordInteractionsRouter({
      publicKeyHex: keys.publicKeyHex,
      getAdapter: () => null,
      nowMs: () => 1_700_000_000_000,
    }),
  );
  app.use('/api', limiter, authMiddleware);
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  const upstream = await listen(app);
  const filter = await listenDiscordInteractionsPathFilter({
    upstreamOrigin: `http://127.0.0.1:${upstream.port}`,
    listenHost: '127.0.0.1',
    listenPort: 0,
  });
  const filterPort = (filter.server.address() as { port: number }).port;

  try {
    const deniedHealth = await fetch(`http://127.0.0.1:${filterPort}/api/health`);
    assert.equal(deniedHealth.status, 404);

    const deniedAuth = await fetch(`http://127.0.0.1:${filterPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(deniedAuth.status, 404);

    const deniedGetIx = await fetch(`http://127.0.0.1:${filterPort}${DISCORD_INTERACTIONS_PATH}`);
    assert.equal(deniedGetIx.status, 404);

    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';
    const signatureHex = keys.sign(timestamp, body);
    const ping = await fetch(`http://127.0.0.1:${filterPort}${DISCORD_INTERACTIONS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': signatureHex,
        'x-signature-timestamp': timestamp,
      },
      body,
    });
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { type: 1 });
  } finally {
    await new Promise<void>((resolve, reject) => {
      filter.server.close((err) => (err ? reject(err) : resolve()));
    });
    await upstream.close();
  }
});

test('listenDiscordInteractionsPathFilter defaults to localhost bind', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upPort = (upstream.address() as { port: number }).port;
  const filter = await listenDiscordInteractionsPathFilter({
    upstreamOrigin: `http://127.0.0.1:${upPort}`,
    listenPort: 0,
  });
  try {
    const addr = filter.server.address();
    assert.ok(addr && typeof addr === 'object');
    assert.equal(addr.address, '127.0.0.1');
  } finally {
    await new Promise<void>((resolve, reject) => {
      filter.server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
