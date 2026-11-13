/**
 * F4 follow-up: raw-body parser failures must consume the unauthenticated budget
 * under real createApp() wiring (including the generic errorHandler).
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Express } from 'express';
import { config } from '../config.js';
import { MemoryDiscordFollowUp } from './follow-up.js';
import { classifyDiscordRawBodyError } from './interactions-http.js';

const TIMESTAMP = '1700000000';
const APP_ID = '999000000000000001';
const GUILD = '111';
const CLIENT_KEY = 'ipv4:127.0.0.1';

type HitStore = {
  limit: number;
  size: number;
  get: (key: string) => { totalHits: number } | undefined;
  increment: (key: string) => { totalHits: number };
};

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    sign(timestamp: string, body: string) {
      return sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex');
    },
  };
}

function commandBody(id: string) {
  return JSON.stringify({
    type: 2,
    id,
    application_id: APP_ID,
    token: 'test-interaction-token',
    guild_id: GUILD,
    member: {
      user: { id: 'u-admin' },
      roles: ['r-admin'],
      permissions: '0',
    },
    data: { name: 'ts', options: [{ name: 'help', type: 1 }] },
  });
}

let musicDir = '';
let previousMusicDir: string | undefined;
const configSnapshot = {
  discordInteractionsEnabled: config.discordInteractionsEnabled,
  discordPublicKeyHex: config.discordPublicKeyHex,
  discordApplicationId: config.discordApplicationId,
};

before(async () => {
  musicDir = await mkdtemp(join(tmpdir(), 'ts6-f4-parser-'));
  previousMusicDir = process.env.MUSIC_DIR;
  process.env.MUSIC_DIR = musicDir;
});

after(async () => {
  Object.assign(config, configSnapshot);
  if (previousMusicDir === undefined) delete process.env.MUSIC_DIR;
  else process.env.MUSIC_DIR = previousMusicDir;
  await rm(musicDir, { recursive: true, force: true });
});

async function createDiscordApp(opts: {
  publicKeyHex: string;
  handled?: { count: number };
}) {
  Object.assign(config, {
    discordInteractionsEnabled: true,
    discordPublicKeyHex: opts.publicKeyHex,
    discordApplicationId: APP_ID,
  });
  const { createApp } = await import('../app.js');
  const app = createApp() as Express;
  const handled = opts.handled ?? { count: 0 };
  app.locals.discordCommandAdapter = {
    async handle() {
      handled.count += 1;
      return { ok: true, code: 'ok', ephemeral: true, content: 'ok', ack: 'immediate' };
    },
  };
  app.locals.discordInteractionFollowUp = new MemoryDiscordFollowUp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    app,
    handled,
    port: address.port,
    unauth: app.locals.discordInteractionsUnauthRateLimitStore as HitStore,
    auth: app.locals.discordInteractionsAuthRateLimitStore as HitStore,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      });
    },
  };
}

async function waitForUnauthHits(store: HitStore, minHits: number, deadlineMs = 15_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const hits = store.get(CLIENT_KEY)?.totalHits ?? 0;
    if (hits >= minHits) return hits;
    // Yield to timers/I/O — a setImmediate spin starves the abort error path.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${minHits} unauth hits (have ${store.get(CLIENT_KEY)?.totalHits ?? 0})`);
}

/** Start a POST, send a short prefix, then destroy before Content-Length is satisfied. */
function abortPartialUpload(port: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/discord/interactions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(64 * 1024),
        'x-signature-ed25519': 'ab'.repeat(64),
        'x-signature-timestamp': TIMESTAMP,
      },
    });
    req.on('error', done);
    req.on('close', done);
    req.write(Buffer.alloc(128, 0x61));
    // Yield so headers/body reach express.raw before destroy (emits request.aborted).
    setTimeout(() => {
      req.destroy();
    }, 20);
  });
}

async function postRaw(
  port: number,
  opts: {
    body: Buffer | string;
    headers?: Record<string, string>;
    signatureHex?: string | null;
    timestamp?: string;
  },
) {
  const body = typeof opts.body === 'string' ? Buffer.from(opts.body) : opts.body;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(body.length),
    ...(opts.headers ?? {}),
  };
  if (opts.signatureHex !== null) {
    headers['x-signature-ed25519'] = opts.signatureHex ?? 'ab'.repeat(64);
    headers['x-signature-timestamp'] = opts.timestamp ?? TIMESTAMP;
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/discord/interactions`, {
    method: 'POST',
    headers,
    body,
  });
  const text = await response.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: response.status, body: json, text };
}

function captureConsoleErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    restore() {
      console.error = original;
    },
  };
}

function gzipCorrupt(): Buffer {
  // Invalid gzip payload (not a well-formed stream).
  return Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]);
}

describe('F4 createApp raw-body parser rate limiting', () => {
  it('classifies request.aborted as an expected raw-body failure', () => {
    assert.equal(classifyDiscordRawBodyError({ type: 'request.aborted', status: 400 }), 400);
    assert.equal(classifyDiscordRawBodyError({ type: 'request.aborted', statusCode: 400 }), 400);
    assert.equal(classifyDiscordRawBodyError({ type: 'something.else', status: 500 }), null);
  });

  it('A: oversized bodies return 413 then 429 without 500s, side effects, or error logs', async () => {
    const keys = ed25519();
    const handled = { count: 0 };
    const f = await createDiscordApp({ publicKeyHex: keys.publicKeyHex, handled });
    const log = captureConsoleErrors();
    try {
      const huge = Buffer.alloc(300 * 1024, 0x61);
      const statuses = new Map<number, number>();
      for (let i = 0; i < f.unauth.limit + 5; i++) {
        const res = await postRaw(f.port, { body: huge, signatureHex: 'ab'.repeat(64) });
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      }
      assert.ok((statuses.get(413) ?? 0) >= 1, `expected 413s, got ${[...statuses]}`);
      assert.ok((statuses.get(429) ?? 0) >= 1, `expected 429s, got ${[...statuses]}`);
      assert.equal(statuses.get(500) ?? 0, 0);
      assert.equal(handled.count, 0);
      assert.equal(log.lines.filter((l) => l.includes('[Error')).length, 0, log.lines.join('\n'));
      assert.equal(f.auth.size, 0);
      const sample = await postRaw(f.port, { body: huge, signatureHex: 'ab'.repeat(64) });
      assert.ok(sample.status === 429 || sample.status === 413);
      assert.equal(typeof (sample.body as { error?: unknown }).error, 'string');
      assert.ok(!JSON.stringify(sample.body).includes('stack'));
    } finally {
      log.restore();
      await f.close();
    }
  });

  it('B: unsupported Content-Encoding returns 415 then 429 without 500s or error logs', async () => {
    const keys = ed25519();
    const handled = { count: 0 };
    const f = await createDiscordApp({ publicKeyHex: keys.publicKeyHex, handled });
    const log = captureConsoleErrors();
    try {
      const statuses = new Map<number, number>();
      for (let i = 0; i < f.unauth.limit + 5; i++) {
        const res = await postRaw(f.port, {
          body: Buffer.from('xx'),
          headers: { 'content-encoding': 'br' },
          signatureHex: 'ab'.repeat(64),
        });
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      }
      assert.ok((statuses.get(415) ?? 0) >= 1, `expected 415s, got ${[...statuses]}`);
      assert.ok((statuses.get(429) ?? 0) >= 1, `expected 429s, got ${[...statuses]}`);
      assert.equal(statuses.get(500) ?? 0, 0);
      assert.equal(handled.count, 0);
      assert.equal(log.lines.filter((l) => l.includes('[Error')).length, 0, log.lines.join('\n'));
    } finally {
      log.restore();
      await f.close();
    }
  });

  it('C: corrupt gzip returns 400 then 429 without command execution or error logs', async () => {
    const keys = ed25519();
    const handled = { count: 0 };
    const f = await createDiscordApp({ publicKeyHex: keys.publicKeyHex, handled });
    const log = captureConsoleErrors();
    try {
      const statuses = new Map<number, number>();
      for (let i = 0; i < f.unauth.limit + 5; i++) {
        const res = await postRaw(f.port, {
          body: gzipCorrupt(),
          headers: { 'content-encoding': 'gzip' },
          signatureHex: 'ab'.repeat(64),
        });
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      }
      assert.ok((statuses.get(400) ?? 0) >= 1, `expected 400s, got ${[...statuses]}`);
      assert.ok((statuses.get(429) ?? 0) >= 1, `expected 429s, got ${[...statuses]}`);
      assert.equal(statuses.get(500) ?? 0, 0);
      assert.equal(handled.count, 0);
      assert.equal(log.lines.filter((l) => l.includes('[Error')).length, 0, log.lines.join('\n'));
    } finally {
      log.restore();
      await f.close();
    }
  });

  it('D: exhausting unauth with malformed bodies leaves authenticated budget for a signed command', async () => {
    const keys = ed25519();
    const handled = { count: 0 };
    const f = await createDiscordApp({ publicKeyHex: keys.publicKeyHex, handled });
    // Align signed timestamp with Discord freshness window (receiver clock).
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const huge = Buffer.alloc(300 * 1024, 0x62);
      for (let i = 0; i < f.unauth.limit + 3; i++) {
        const res = await postRaw(f.port, { body: huge, signatureHex: 'cd'.repeat(64) });
        assert.ok(res.status === 413 || res.status === 429, `unexpected ${res.status}`);
      }
      // Invalid signatures also burn unauth only (already exhausted → 429).
      for (let i = 0; i < 5; i++) {
        const body = commandBody(`ix-bad-${i}`);
        const res = await postRaw(f.port, { body, signatureHex: 'ef'.repeat(64), timestamp });
        assert.equal(res.status, 429);
      }

      const body = commandBody('ix-signed-after-unauth');
      const signed = await postRaw(f.port, {
        body,
        signatureHex: keys.sign(timestamp, body),
        timestamp,
      });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(handled.count, 1);
      assert.ok(f.auth.size >= 1);
    } finally {
      await f.close();
    }
  });

  it('F4-R1: aborted uploads consume unauth quota without error logs; signed commands still work', async () => {
    const keys = ed25519();
    const handled = { count: 0 };
    const f = await createDiscordApp({ publicKeyHex: keys.publicKeyHex, handled });
    const log = captureConsoleErrors();
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const target = f.unauth.limit + 10;
      for (let i = 1; i <= target; i++) {
        await abortPartialUpload(f.port);
        await waitForUnauthHits(f.unauth, i);
      }
      assert.ok((f.unauth.get(CLIENT_KEY)?.totalHits ?? 0) >= f.unauth.limit + 10);
      assert.equal(f.auth.size, 0);
      assert.equal(handled.count, 0);
      assert.equal(log.lines.filter((l) => l.includes('[Error')).length, 0, log.lines.join('\n'));

      // Socket still open: further unauthenticated traffic is 429.
      const limited = await postRaw(f.port, {
        body: commandBody('ix-after-abort-flood'),
        signatureHex: 'cd'.repeat(64),
        timestamp,
      });
      assert.equal(limited.status, 429);

      const body = commandBody('ix-signed-after-abort-flood');
      const signed = await postRaw(f.port, {
        body,
        signatureHex: keys.sign(timestamp, body),
        timestamp,
      });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(handled.count, 1);
      assert.ok((f.auth.get(CLIENT_KEY)?.totalHits ?? 0) >= 1);
    } finally {
      log.restore();
      await f.close();
    }
  });

  it('E: valid / invalid signatures and misconfigured fail-closed still hold under createApp', async () => {
    const keys = ed25519();
    const handled = { count: 0 };
    const f = await createDiscordApp({ publicKeyHex: keys.publicKeyHex, handled });
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const body = commandBody('ix-e-ok');
      const ok = await postRaw(f.port, {
        body,
        signatureHex: keys.sign(timestamp, body),
        timestamp,
      });
      assert.equal(ok.status, 200);
      assert.equal(handled.count, 1);

      const missing = await postRaw(f.port, { body: commandBody('ix-e-miss'), signatureHex: null });
      assert.equal(missing.status, 401);

      const bad = await postRaw(f.port, {
        body: commandBody('ix-e-bad'),
        signatureHex: '11'.repeat(64),
        timestamp,
      });
      assert.equal(bad.status, 401);
    } finally {
      await f.close();
    }

    Object.assign(config, {
      discordInteractionsEnabled: true,
      discordPublicKeyHex: 'not-a-valid-key',
      discordApplicationId: APP_ID,
    });
    const { createApp } = await import('../app.js');
    const mis = createApp();
    const server = mis.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      const res = await postRaw(address.port, { body: '{}', signatureHex: null });
      assert.equal(res.status, 503);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      });
    }
  });
});
