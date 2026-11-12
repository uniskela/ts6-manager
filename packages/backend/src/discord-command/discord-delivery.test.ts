import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  assertSafeDiscordApiBase,
  classifyFetchNetworkError,
  createDiscordWebhookFollowUp,
  createDiscordWebhookFollowUpFromConfig,
  discordEditOriginalBody,
  DISCORD_429_WAIT_BUDGET_MS,
  DISCORD_MESSAGE_CONTENT_MAX,
  isDiscordApplicationId,
  parseDiscordRetryAfterMs,
  truncateDiscordContent,
  type DiscordHttpTransport,
} from './discord-delivery.js';
import { createDiscordInteractionsRouter } from './interactions-http.js';
import { discordDeferredAck, safeCommandFailure } from './http-response.js';
import { installDiscordCommandRuntime, clearDiscordCommandRuntime } from './backend-runtime.js';

const APP_ID = '999000000000000001';
const TOKEN = 'super-secret-interaction-TOKEN-do-not-leak';
const GUILD = '111';
const NOW_MS = 1_700_000_000_000;
const TIMESTAMP = '1700000000';

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    sign(timestamp: string, body: string) {
      return sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex');
    },
  };
}

async function listen(app: Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function playBody(id = 'ix-1') {
  return JSON.stringify({
    type: 2,
    id,
    application_id: APP_ID,
    token: TOKEN,
    guild_id: GUILD,
    member: { user: { id: 'u1' }, roles: ['r'], permissions: '0' },
    data: { name: 'play', options: [{ name: 'query', type: 3, value: 'song' }] },
  });
}

function helpBody() {
  return JSON.stringify({
    type: 2,
    id: 'ix-help',
    application_id: APP_ID,
    token: TOKEN,
    guild_id: GUILD,
    member: { user: { id: 'u1' }, roles: ['r-admin'], permissions: '0' },
    data: { name: 'ts', options: [{ name: 'help', type: 1 }] },
  });
}

type MockHit = {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
};

async function mockDiscordApi(handler: (hit: MockHit, res: http.ServerResponse) => void | Promise<void>) {
  const hits: MockHit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const hit: MockHit = {
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        headers: req.headers,
      };
      hits.push(hit);
      void Promise.resolve(handler(hit, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    hits,
    baseUrl: `http://127.0.0.1:${port}/api/v10`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function job(partial: {
  result?: import('./adapter.js').CommandResult;
  interactionId?: string;
  receivedAtMs?: number;
  token?: string;
  applicationId?: string;
}) {
  return {
    interactionId: partial.interactionId ?? 'ix-1',
    guildId: GUILD,
    userId: 'u1',
    command: 'play',
    result: partial.result ?? { ok: true, ephemeral: true, content: 'Queued.', ack: 'deferred' as const },
    applicationId: partial.applicationId ?? APP_ID,
    interactionToken: partial.token ?? TOKEN,
    receivedAtMs: partial.receivedAtMs ?? NOW_MS,
  };
}

describe('Discord deferred delivery (Phase 2C step 3B.1)', () => {
  it('helpers: application id, truncate, safe base, edit body', () => {
    assert.equal(isDiscordApplicationId(APP_ID), true);
    assert.equal(isDiscordApplicationId('abc'), false);
    assert.equal(truncateDiscordContent('x'.repeat(DISCORD_MESSAGE_CONTENT_MAX)).length, DISCORD_MESSAGE_CONTENT_MAX);
    assert.ok(truncateDiscordContent('x'.repeat(DISCORD_MESSAGE_CONTENT_MAX + 10)).endsWith('…'));
    assert.equal(assertSafeDiscordApiBase('https://discord.com/api/v10'), 'https://discord.com/api/v10');
    assert.throws(() => assertSafeDiscordApiBase('http://evil.example/api'));
    const body = discordEditOriginalBody({
      ok: true,
      ephemeral: true,
      content: 'hello @everyone <@123>',
      ack: 'deferred',
    });
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal('flags' in body, false);
    assert.match(body.content, /@everyone/);
  });

  it('ephemeral visibility: type-5 sets flags=64; PATCH never flips flags', () => {
    const ephemeralAck = discordDeferredAck(true);
    assert.equal(ephemeralAck.type, 5);
    assert.equal(ephemeralAck.data?.flags, 1 << 6);

    const publicAck = discordDeferredAck(false);
    assert.equal(publicAck.type, 5);
    assert.equal(publicAck.data?.flags, 0);

    const ephemeralEdit = discordEditOriginalBody({
      ok: true, ephemeral: true, content: 'secret', ack: 'deferred',
    });
    const publicEdit = discordEditOriginalBody({
      ok: true, ephemeral: false, content: 'public', ack: 'deferred',
    });
    assert.equal('flags' in ephemeralEdit, false);
    assert.equal('flags' in publicEdit, false);
    assert.equal(ephemeralEdit.content, 'secret');
    assert.equal(publicEdit.content, 'public');
  });

  it('1. successful deferred command edits the original response', async () => {
    const api = await mockDiscordApi((hit, res) => {
      assert.equal(hit.method, 'PATCH');
      assert.match(hit.url, new RegExp(`/webhooks/${APP_ID}/.+/messages/@original`));
      assert.doesNotMatch(hit.url, /discord\.com/);
      const parsed = JSON.parse(hit.body);
      assert.equal(parsed.content, 'Queued: track');
      assert.deepEqual(parsed.allowed_mentions, { parse: [] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm1', content: parsed.content }));
    });
    try {
      const followUp = createDiscordWebhookFollowUp({
        applicationId: APP_ID,
        apiBaseUrl: api.baseUrl,
        nowMs: () => NOW_MS + 100,
      });
      await followUp.afterDeferred(job({
        result: { ok: true, ephemeral: true, content: 'Queued: track', ack: 'deferred' },
      }));
      assert.equal(api.hits.length, 1);
      assert.doesNotMatch(JSON.stringify(api.hits[0].headers), new RegExp(TOKEN));
    } finally {
      await api.close();
    }
  });

  it('2. failed command edits the original response with a safe error', async () => {
    const api = await mockDiscordApi((hit, res) => {
      const parsed = JSON.parse(hit.body);
      assert.equal(parsed.content, 'Music bot is unavailable.');
      assert.equal('flags' in parsed, false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    try {
      const followUp = createDiscordWebhookFollowUp({
        applicationId: APP_ID,
        apiBaseUrl: api.baseUrl,
        nowMs: () => NOW_MS,
      });
      await followUp.afterDeferred(job({
        result: { ok: false, code: 'unavailable', ephemeral: true, content: 'Music bot is unavailable.', ack: 'deferred' },
      }));
      assert.equal(api.hits.length, 1);
    } finally {
      await api.close();
    }
  });

  it('public deferred edit also omits flags (visibility fixed by type-5)', async () => {
    const api = await mockDiscordApi((hit, res) => {
      const parsed = JSON.parse(hit.body);
      assert.equal(parsed.content, 'Now playing publicly');
      assert.equal('flags' in parsed, false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    try {
      const followUp = createDiscordWebhookFollowUp({
        applicationId: APP_ID,
        apiBaseUrl: api.baseUrl,
        nowMs: () => NOW_MS,
      });
      await followUp.afterDeferred(job({
        interactionId: 'ix-public',
        result: { ok: true, ephemeral: false, content: 'Now playing publicly', ack: 'deferred' },
      }));
      assert.equal(api.hits.length, 1);
    } finally {
      await api.close();
    }
  });

  it('3. command exception cannot leave the interaction silently unresolved', async () => {
    const keys = ed25519();
    const edits: string[] = [];
    const api = await mockDiscordApi((hit, res) => {
      edits.push(JSON.parse(hit.body).content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      apiBaseUrl: api.baseUrl,
      nowMs: () => NOW_MS,
    });
    const app = express();
    app.locals.discordCommandAdapter = {
      async handle() {
        throw new Error(`boom token=${TOKEN}`);
      },
    };
    app.locals.discordInteractionFollowUp = followUp;
    app.use('/api/discord/interactions', createDiscordInteractionsRouter({
      publicKeyHex: keys.publicKeyHex,
      getAdapter: (req) => req.app.locals.discordCommandAdapter,
      getFollowUp: (req) => req.app.locals.discordInteractionFollowUp,
      expectedApplicationId: APP_ID,
      nowMs: () => NOW_MS,
    }));
    const srv = await listen(app);
    try {
      const body = playBody('ix-throw');
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': keys.sign(TIMESTAMP, body),
          'x-signature-timestamp': TIMESTAMP,
        },
        body,
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json() as any).type, 5);
      for (let i = 0; i < 40 && edits.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(edits.length, 1);
      assert.equal(edits[0], safeCommandFailure().content);
      assert.doesNotMatch(edits[0], new RegExp(TOKEN));
    } finally {
      followUp.dispose();
      await srv.close();
      await api.close();
    }
  });

  it('4. missing delivery configuration prevents type-5 acknowledgement', async () => {
    assert.equal(createDiscordWebhookFollowUpFromConfig({ applicationId: '' }), null);
    assert.equal(createDiscordWebhookFollowUpFromConfig({ applicationId: 'nope' }), null);

    const keys = ed25519();
    const app = express();
    app.locals.discordCommandAdapter = {
      async handle() {
        return { ok: true, ephemeral: true, content: 'x', ack: 'deferred' };
      },
    };
    app.locals.discordInteractionFollowUp = null;
    app.use('/api/discord/interactions', createDiscordInteractionsRouter({
      publicKeyHex: keys.publicKeyHex,
      getAdapter: (req) => req.app.locals.discordCommandAdapter,
      getFollowUp: () => null,
      expectedApplicationId: APP_ID,
      nowMs: () => NOW_MS,
    }));
    const srv = await listen(app);
    try {
      const body = playBody();
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': keys.sign(TIMESTAMP, body),
          'x-signature-timestamp': TIMESTAMP,
        },
        body,
      });
      assert.equal(res.status, 503);
      assert.doesNotMatch(await res.text(), /"type"\s*:\s*5/);
    } finally {
      await srv.close();
    }
  });

  it('5–6. only one initial acknowledgement and no duplicate follow-up delivery', async () => {
    let patches = 0;
    const api = await mockDiscordApi((_hit, res) => {
      patches += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    try {
      const followUp = createDiscordWebhookFollowUp({
        applicationId: APP_ID,
        apiBaseUrl: api.baseUrl,
        nowMs: () => NOW_MS,
      });
      const j = job({ interactionId: 'ix-dedupe' });
      await followUp.afterDeferred(j);
      await followUp.afterDeferred(j);
      assert.equal(patches, 1);
    } finally {
      await api.close();
    }
  });

  it('keeps dedupe records only for the interaction token lifetime (bounded memory)', async () => {
    let patches = 0;
    const api = await mockDiscordApi((_hit, res) => {
      patches += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    try {
      let now = NOW_MS;
      const ttl = 1_000;
      const followUp = createDiscordWebhookFollowUp({
        applicationId: APP_ID,
        apiBaseUrl: api.baseUrl,
        nowMs: () => now,
        tokenTtlMs: ttl,
      });
      await followUp.afterDeferred(job({ interactionId: 'ix-ttl', receivedAtMs: now }));
      assert.equal(patches, 1);

      // Still inside the token lifetime: a repeat is suppressed.
      now = NOW_MS + ttl - 1;
      await followUp.afterDeferred(job({ interactionId: 'ix-ttl', receivedAtMs: now }));
      assert.equal(patches, 1);

      // Past the lifetime the original token is dead, so the record is dropped
      // rather than kept for the life of the process.
      now = NOW_MS + ttl;
      await followUp.afterDeferred(job({ interactionId: 'ix-ttl', receivedAtMs: now }));
      assert.equal(patches, 2);
    } finally {
      await api.close();
    }
  });

  it('7. delivery timeout is bounded (ambiguous — no retry)', async () => {
    let hits = 0;
    const transport: DiscordHttpTransport = {
      async fetch(_url, init) {
        hits += 1;
        await new Promise<void>((_resolve, reject) => {
          const t = setTimeout(() => reject(Object.assign(new Error('hang'), { name: 'TimeoutError' })), 60_000);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
          }, { once: true });
        });
        throw new Error('unreachable');
      },
    };
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      apiBaseUrl: 'https://discord.com/api/v10',
      transport,
      requestTimeoutMs: 30,
      nowMs: () => NOW_MS,
    });
    const started = Date.now();
    await assert.rejects(() => followUp.afterDeferred(job({ interactionId: 'ix-timeout' })), /unknown|aborted|delivery/i);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(hits, 1);
  });

  it('connection refused retries once; ambiguous network does not', async () => {
    assert.equal(classifyFetchNetworkError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })), 'unsent');
    assert.equal(classifyFetchNetworkError(Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
    })), 'unsent');
    assert.equal(classifyFetchNetworkError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 'unknown');
    assert.equal(classifyFetchNetworkError(Object.assign(new Error('hang'), { name: 'TimeoutError' })), 'unknown');

    let refusedHits = 0;
    const refused: DiscordHttpTransport = {
      async fetch() {
        refusedHits += 1;
        if (refusedHits === 1) {
          throw Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
            discordUnsent: true,
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    };
    await createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      transport: refused,
      nowMs: () => NOW_MS,
    }).afterDeferred(job({ interactionId: 'ix-refused' }));
    assert.equal(refusedHits, 2);

    let ambiguousHits = 0;
    const ambiguous: DiscordHttpTransport = {
      async fetch() {
        ambiguousHits += 1;
        throw Object.assign(new Error('other side closed'), { code: 'ECONNRESET' });
      },
    };
    await assert.rejects(
      () => createDiscordWebhookFollowUp({
        applicationId: APP_ID,
        transport: ambiguous,
        nowMs: () => NOW_MS,
      }).afterDeferred(job({ interactionId: 'ix-ambiguous' })),
      /unknown/i,
    );
    assert.equal(ambiguousHits, 1);
  });

  it('8. expired interaction token is not used', async () => {
    let hits = 0;
    const transport: DiscordHttpTransport = {
      async fetch() {
        hits += 1;
        return new Response('{}', { status: 200 });
      },
    };
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      transport,
      nowMs: () => NOW_MS + 16 * 60 * 1000,
      tokenTtlMs: 15 * 60 * 1000,
    });
    await assert.rejects(
      () => followUp.afterDeferred(job({ receivedAtMs: NOW_MS })),
      /expired/i,
    );
    assert.equal(hits, 0);
  });

  it('9. 429 handling respects rate limits (fractional retry_after)', async () => {
    let hits = 0;
    let waitedAtLeast = false;
    const transport: DiscordHttpTransport = {
      async fetch() {
        hits += 1;
        if (hits === 1) {
          return new Response(JSON.stringify({
            message: 'You are being rate limited.',
            retry_after: 0.05,
            global: false,
          }), {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': '0.05',
            },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    };
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      transport,
      nowMs: () => NOW_MS,
      rateLimitWaitBudgetMs: DISCORD_429_WAIT_BUDGET_MS,
    });
    const started = Date.now();
    await followUp.afterDeferred(job({ interactionId: 'ix-429' }));
    waitedAtLeast = Date.now() - started >= 50;
    assert.equal(hits, 2);
    assert.equal(waitedAtLeast, true);
    assert.equal(parseDiscordRetryAfterMs(
      new Response('', { status: 429, headers: { 'retry-after': '0.25' } }),
    ), 250);
    assert.equal(parseDiscordRetryAfterMs(
      new Response(JSON.stringify({ retry_after: 1.1 }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
      JSON.stringify({ retry_after: 1.1 }),
    ), 1100);
  });

  it('429 requiring delay above wait budget fails without early retry', async () => {
    let hits = 0;
    const transport: DiscordHttpTransport = {
      async fetch() {
        hits += 1;
        return new Response(JSON.stringify({ retry_after: 6.5 }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '6.5',
          },
        });
      },
    };
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      transport,
      nowMs: () => NOW_MS,
      rateLimitWaitBudgetMs: DISCORD_429_WAIT_BUDGET_MS,
    });
    await assert.rejects(
      () => followUp.afterDeferred(job({ interactionId: 'ix-429-long' })),
      /rate limited/i,
    );
    assert.equal(hits, 1);
    assert.ok(6.5 * 1000 > DISCORD_429_WAIT_BUDGET_MS);
  });

  it('10. 401/403/404 failures are reported safely', async () => {
    for (const status of [401, 403, 404]) {
      const diags: string[] = [];
      const transport: DiscordHttpTransport = {
        async fetch() {
          return new Response('nope', { status });
        },
      };
      const followUp = createDiscordWebhookFollowUp({
        applicationId: APP_ID,
        transport,
        nowMs: () => NOW_MS,
        onDiagnostic: (m) => diags.push(m),
      });
      await assert.rejects(
        () => followUp.afterDeferred(job({ interactionId: `ix-${status}` })),
        /delivery failed/i,
      );
      assert.equal(diags.length, 1);
      assert.doesNotMatch(diags[0], new RegExp(TOKEN));
      assert.doesNotMatch(diags[0], /webhooks\/\d+\/[^/\s]+/);
    }
  });

  it('11. 5xx handling has bounded retry behaviour', async () => {
    let hits = 0;
    const transport: DiscordHttpTransport = {
      async fetch() {
        hits += 1;
        return new Response('err', { status: 502 });
      },
    };
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      transport,
      nowMs: () => NOW_MS,
    });
    await assert.rejects(
      () => followUp.afterDeferred(job({ interactionId: 'ix-5xx' })),
      /502/,
    );
    assert.equal(hits, 3);
  });

  it('12. unexpected response bodies do not crash the backend', async () => {
    const transport: DiscordHttpTransport = {
      async fetch() {
        return new Response('<<<not-json>>>', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      transport,
      nowMs: () => NOW_MS,
    });
    await followUp.afterDeferred(job({ interactionId: 'ix-weird' }));
  });

  it('13. interaction token never appears in logs or error output', async () => {
    const diags: string[] = [];
    const transport: DiscordHttpTransport = {
      async fetch() {
        return new Response(`token=${TOKEN}`, { status: 500 });
      },
    };
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      transport,
      nowMs: () => NOW_MS,
      onDiagnostic: (m) => diags.push(m),
    });
    let errMsg = '';
    try {
      await followUp.afterDeferred(job({ interactionId: 'ix-log' }));
    } catch (err) {
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.doesNotMatch(errMsg, new RegExp(TOKEN));
    for (const line of diags) assert.doesNotMatch(line, new RegExp(TOKEN));
  });

  it('14. allowed mentions cannot trigger unwanted pings', () => {
    const body = discordEditOriginalBody({
      ok: true,
      ephemeral: true,
      content: '@everyone <@&1> <@!2>',
      ack: 'deferred',
    });
    assert.deepEqual(body.allowed_mentions.parse, []);
    assert.equal('flags' in body, false);
  });

  it('15. backend shutdown handles pending delivery safely', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transport: DiscordHttpTransport = {
      async fetch(_url, init) {
        await gate;
        if (init.signal?.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return new Response('{}', { status: 200 });
      },
    };
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      transport,
      nowMs: () => NOW_MS,
      requestTimeoutMs: 10_000,
    });
    const pending = followUp.afterDeferred(job({ interactionId: 'ix-shutdown' }));
    followUp.dispose();
    release();
    await assert.rejects(() => pending, /abort|shutting down|delivery/i);
  });

  it('16. existing synchronous type-4 responses still work', async () => {
    const keys = ed25519();
    const app = express();
    app.locals.discordCommandAdapter = {
      async handle() {
        return { ok: true, ephemeral: false, content: 'help-ok', ack: 'immediate' };
      },
    };
    app.use('/api/discord/interactions', createDiscordInteractionsRouter({
      publicKeyHex: keys.publicKeyHex,
      getAdapter: (req) => req.app.locals.discordCommandAdapter,
      getFollowUp: () => null,
      expectedApplicationId: APP_ID,
      nowMs: () => NOW_MS,
    }));
    const srv = await listen(app);
    try {
      const body = helpBody();
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': keys.sign(TIMESTAMP, body),
          'x-signature-timestamp': TIMESTAMP,
        },
        body,
      });
      assert.equal(res.status, 200);
      const json = await res.json() as any;
      assert.equal(json.type, 4);
      assert.equal(json.data.content, 'help-ok');
    } finally {
      await srv.close();
    }
  });

  it('runtime install wires follow-up without Discord I/O at construct time', () => {
    let fetches = 0;
    const transport: DiscordHttpTransport = {
      async fetch() {
        fetches += 1;
        return new Response('{}', { status: 200 });
      },
    };
    const followUp = createDiscordWebhookFollowUp({
      applicationId: APP_ID,
      transport,
      nowMs: () => NOW_MS,
    });
    const app = express();
    installDiscordCommandRuntime(app, {
      adapter: { async handle() { return { ok: true, ephemeral: true, content: 'x', ack: 'immediate' }; } },
      followUp,
      bindings: { async get() { return null; } },
    });
    assert.equal(app.locals.discordInteractionFollowUp, followUp);
    assert.equal(fetches, 0);
    clearDiscordCommandRuntime(app);
    assert.equal(app.locals.discordInteractionFollowUp, undefined);
  });

  it('application id mismatch on signed body is rejected before type 5', async () => {
    const keys = ed25519();
    let handles = 0;
    const app = express();
    app.locals.discordCommandAdapter = {
      async handle() {
        handles += 1;
        return { ok: true, ephemeral: true, content: 'x', ack: 'deferred' };
      },
    };
    app.locals.discordInteractionFollowUp = {
      async afterDeferred() {},
    };
    app.use('/api/discord/interactions', createDiscordInteractionsRouter({
      publicKeyHex: keys.publicKeyHex,
      getAdapter: (req) => req.app.locals.discordCommandAdapter,
      getFollowUp: (req) => req.app.locals.discordInteractionFollowUp,
      expectedApplicationId: APP_ID,
      nowMs: () => NOW_MS,
    }));
    const body = JSON.stringify({
      type: 2,
      id: 'ix-mismatch',
      application_id: '111111111111111111',
      token: TOKEN,
      guild_id: GUILD,
      member: { user: { id: 'u1' }, roles: ['r'], permissions: '0' },
      data: { name: 'play', options: [{ name: 'query', type: 3, value: 'x' }] },
    });
    const srv = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': keys.sign(TIMESTAMP, body),
          'x-signature-timestamp': TIMESTAMP,
        },
        body,
      });
      assert.equal(res.status, 401);
      assert.equal(handles, 0);
    } finally {
      await srv.close();
    }
  });
});
