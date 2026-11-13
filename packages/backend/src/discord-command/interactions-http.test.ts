import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { defaultMediaCommandPermissions } from '../voice/media-command-permissions.js';
import { PlayQueue, type QueueItem } from '../voice/playlist/queue.js';
import { createDiscordCommandAdapter, type DiscordCommandIntent } from './adapter.js';
import { MemoryDiscordFollowUp } from './follow-up.js';
import { safeCommandFailure } from './http-response.js';
import {
  createDiscordInteractionsMisconfiguredRouter,
  createDiscordInteractionsRouter,
  isValidDiscordPublicKeyHex,
  type DiscordInteractionRateGates,
} from './interactions-http.js';
import { MemoryCommandIdempotency } from './idempotency.js';
import { createMusicCommandService } from './music-service.js';
import { createDiscordCommandRuntime, MemoryGuildBindingLookup } from './runtime.js';
import { MemoryReplayGuard } from './security.js';

const NOW_MS = 1_700_000_000_000;
const TIMESTAMP = '1700000000';
const GUILD = '111';
const APP_ID = '999000000000000001';
const IX_TOKEN = 'test-interaction-token-not-for-prod';
const SECRET_MARKER = 'super-secret-discord-token-do-not-leak';

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    sign(timestamp: string, body: string) {
      return sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex');
    },
  };
}

function track(id: string): QueueItem {
  return {
    id,
    title: id,
    artist: 'A',
    filePath: `/tmp/${id}`,
    source: 'url',
    sourceUrl: `https://8.8.8.8/${id}`,
  };
}

function fakeBot() {
  const bot: any = {
    currentConfig: { id: 1, serverConfigId: 9, queryPort: 10011, volume: 40 },
    status: 'connected',
    nowPlaying: null,
    isStreaming: false,
    stopGeneration: 0,
    playbackProgress: { position: 0, duration: 0 },
    queue: new PlayQueue(),
    playCalls: 0,
    assertMusicCanStart: () => {},
    stopAudio() {
      bot.nowPlaying = null;
      bot.status = 'connected';
    },
    applyVolume: async (volume: number) => {
      bot.currentConfig.volume = volume;
    },
    play: async (item: QueueItem) => {
      bot.playCalls += 1;
      bot.nowPlaying = item;
      bot.status = 'playing';
    },
    playStream: async (item: QueueItem) => {
      bot.playCalls += 1;
      bot.nowPlaying = item;
      bot.status = 'playing';
    },
  };
  return bot;
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

async function postInteraction(
  port: number,
  opts: {
    body: string;
    timestamp?: string;
    signatureHex?: string | null;
    path?: string;
    extraMiddlewareBody?: boolean;
  },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opts.signatureHex !== null) {
    headers['x-signature-ed25519'] = opts.signatureHex ?? '';
    headers['x-signature-timestamp'] = opts.timestamp ?? TIMESTAMP;
  } else if (opts.timestamp) {
    headers['x-signature-timestamp'] = opts.timestamp;
  }
  const response = await fetch(`http://127.0.0.1:${port}${opts.path ?? '/api/discord/interactions'}`, {
    method: 'POST',
    headers,
    body: opts.body,
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

function pingBody() {
  return JSON.stringify({ type: 1 });
}

function commandBody(partial: {
  command?: string;
  guildId?: string;
  userId?: string;
  roles?: string[];
  options?: unknown[];
  id?: string;
  topLevel?: string;
  applicationId?: string | null;
  token?: string | null;
}) {
  const name = partial.topLevel ?? (partial.command?.startsWith('ts.') ? 'ts' : (partial.command ?? 'ts'));
  const sub = partial.command?.startsWith('ts.') ? partial.command.slice(3) : undefined;
  const data = name === 'ts'
    ? { name: 'ts', options: [{ name: sub ?? 'help', type: 1 }] }
    : { name, options: partial.options ?? [] };
  const payload: Record<string, unknown> = {
    type: 2,
    id: partial.id ?? 'ix-1',
    guild_id: partial.guildId ?? GUILD,
    member: {
      user: { id: partial.userId ?? 'u-admin' },
      roles: partial.roles ?? ['r-admin'],
      permissions: '0',
    },
    data,
  };
  if (partial.applicationId !== null) {
    payload.application_id = partial.applicationId === undefined ? APP_ID : partial.applicationId;
  }
  if (partial.token !== null) {
    payload.token = partial.token === undefined ? IX_TOKEN : partial.token;
  }
  return JSON.stringify(payload);
}

function memoryRateGates(opts?: { unauthMax?: number; authMax?: number }): DiscordInteractionRateGates & {
  unauthHits: Map<string, number>;
  authHits: Map<string, number>;
} {
  const unauthMax = opts?.unauthMax ?? 120;
  const authMax = opts?.authMax ?? 120;
  const unauthHits = new Map<string, number>();
  const authHits = new Map<string, number>();
  return {
    unauthHits,
    authHits,
    clientKey: () => 'ipv4:127.0.0.1',
    takeUnauthenticated(key: string) {
      const next = (unauthHits.get(key) ?? 0) + 1;
      unauthHits.set(key, next);
      return next <= unauthMax;
    },
    takeAuthenticated(key: string) {
      const next = (authHits.get(key) ?? 0) + 1;
      authHits.set(key, next);
      return next <= authMax;
    },
  };
}

function enabledApp(opts: {
  keys: ReturnType<typeof ed25519>;
  adapter: { handle(intent: DiscordCommandIntent): Promise<any> } | null;
  /** Omit to inject Memory stub; pass null to simulate missing follow-up. */
  followUp?: MemoryDiscordFollowUp | null;
  expectedApplicationId?: string | null;
  nowMs?: () => number;
  onDeliveryError?: (info: { command: string; guildId: string; reason: string }) => void;
  rateGates?: DiscordInteractionRateGates | null;
  replay?: MemoryReplayGuard | null;
}) {
  const app = express();
  app.locals.discordCommandAdapter = opts.adapter;
  app.locals.discordInteractionFollowUp = opts.followUp === undefined
    ? new MemoryDiscordFollowUp()
    : opts.followUp;
  app.use('/api/discord/interactions', createDiscordInteractionsRouter({
    publicKeyHex: opts.keys.publicKeyHex,
    getAdapter: (req) => req.app.locals.discordCommandAdapter ?? null,
    getFollowUp: (req) => req.app.locals.discordInteractionFollowUp ?? null,
    expectedApplicationId: opts.expectedApplicationId === undefined ? APP_ID : opts.expectedApplicationId,
    nowMs: opts.nowMs ?? (() => NOW_MS),
    onDeliveryError: opts.onDeliveryError,
    rateGates: opts.rateGates,
    replay: opts.replay,
  }));
  app.use(express.json());
  return app;
}

describe('Discord interactions HTTP (Phase 2C step 1)', () => {
  it('validates public key hex shape', () => {
    assert.equal(isValidDiscordPublicKeyHex('a'.repeat(64)), true);
    assert.equal(isValidDiscordPublicKeyHex('zz'), false);
    assert.equal(isValidDiscordPublicKeyHex(''), false);
  });

  it('1. valid PING signature succeeds', async () => {
    const keys = ed25519();
    const body = pingBody();
    const app = enabledApp({
      keys,
      adapter: { async handle() { throw new Error('ping must not dispatch'); } },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { type: 1 });
    } finally {
      await srv.close();
    }
  });

  it('2. invalid signature rejected', async () => {
    const keys = ed25519();
    const other = ed25519();
    const body = pingBody();
    let handles = 0;
    const app = enabledApp({
      keys,
      adapter: { async handle() { handles += 1; return { ok: true, ephemeral: false, content: '', ack: 'immediate' }; } },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: other.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 401);
      assert.equal(handles, 0);
    } finally {
      await srv.close();
    }
  });

  it('3. missing signature rejected', async () => {
    const keys = ed25519();
    let handles = 0;
    const app = enabledApp({
      keys,
      adapter: { async handle() { handles += 1; return { ok: true, ephemeral: false, content: '', ack: 'immediate' }; } },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, { body: pingBody(), signatureHex: null });
      assert.equal(res.status, 401);
      assert.equal(handles, 0);
    } finally {
      await srv.close();
    }
  });

  it('4. expired timestamp rejected', async () => {
    const keys = ed25519();
    const body = pingBody();
    let handles = 0;
    const app = enabledApp({
      keys,
      adapter: { async handle() { handles += 1; return { ok: true, ephemeral: false, content: '', ack: 'immediate' }; } },
      nowMs: () => NOW_MS + 120_000,
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 401);
      assert.equal(handles, 0);
    } finally {
      await srv.close();
    }
  });

  it('5. body modified after signing rejected', async () => {
    const keys = ed25519();
    const body = pingBody();
    const tampered = JSON.stringify({ type: 2 });
    let handles = 0;
    const app = enabledApp({
      keys,
      adapter: { async handle() { handles += 1; return { ok: true, ephemeral: false, content: '', ack: 'immediate' }; } },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body: tampered,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 401);
      assert.equal(handles, 0);
    } finally {
      await srv.close();
    }
  });

  it('6. raw-body verification works with Express json middleware on other routes', async () => {
    const keys = ed25519();
    const body = pingBody();
    const app = express();
    app.use('/api/other', express.json(), (_req, res) => res.json({ ok: true }));
    app.use('/api/discord/interactions', createDiscordInteractionsRouter({
      publicKeyHex: keys.publicKeyHex,
      getAdapter: () => ({ async handle() { throw new Error('no'); } }),
      nowMs: () => NOW_MS,
    }));
    app.use(express.json());
    const srv = await listen(app);
    try {
      const other = await fetch(`http://127.0.0.1:${srv.port}/api/other`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      });
      assert.equal(other.status, 200);
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { type: 1 });
    } finally {
      await srv.close();
    }
  });

  it('7. verified command reaches the existing adapter exactly once', async () => {
    const keys = ed25519();
    const body = commandBody({ command: 'ts.help' });
    const seen: string[] = [];
    const app = enabledApp({
      keys,
      adapter: {
        async handle(intent) {
          seen.push(intent.command);
          return { ok: true, ephemeral: false, content: 'help-ok', ack: 'immediate' };
        },
      },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 200);
      assert.equal((res.body as any).type, 4);
      assert.match((res.body as any).data.content, /help-ok/);
      assert.deepEqual(seen, ['ts.help']);
    } finally {
      await srv.close();
    }
  });

  it('8. invalid command never executes playback', async () => {
    const keys = ed25519();
    const bot = fakeBot();
    const bindings = new MemoryGuildBindingLookup();
    bindings.set(GUILD, { instanceId: 'inst-1', revoked: false, botId: 1 });
    const runtime = createDiscordCommandRuntime({
      bindings,
      policy: { viewerRoleIds: ['r-view'], adminRoleIds: ['r-admin'] },
      presence: {
        async snapshot(_guildId: string) {
          return { connected: true, serverName: 'Lab', nicknames: [], channels: [] };
        },
      },
      music: {
        getBot: (id) => (id === 1 ? bot : null),
        virtualServerIdForBot: () => 2,
        loadMediaPermissions: async () => defaultMediaCommandPermissions(),
        pipeline: {
          resolveSpotify: async (url) => url,
          resolveAppleMusic: async () => ({ tracks: [] }),
          resolveSpotifyCollection: async () => null,
          appleTrackToYouTube: async () => null,
          expandYouTube: async () => null,
          downloadTrack: async () => track('t1'),
        },
        idempotency: new MemoryCommandIdempotency(),
      },
    });
    const body = commandBody({ command: 'not-a-real-command', topLevel: 'not-a-real-command' });
    const app = enabledApp({ keys, adapter: runtime.adapter });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 200);
      assert.equal(bot.playCalls, 0);
      assert.equal(bot.queue.length, 0);
      assert.match((res.body as any).data.content, /Unknown command/i);
    } finally {
      await srv.close();
    }
  });

  it('9. unknown guild or missing bot produces a safe response', async () => {
    const keys = ed25519();
    const bot = fakeBot();
    const bindings = new MemoryGuildBindingLookup();
    bindings.set(GUILD, { instanceId: 'inst-1', revoked: false, botId: 99 });
    const runtime = createDiscordCommandRuntime({
      bindings,
      policy: { viewerRoleIds: ['r-view'], adminRoleIds: ['r-admin'] },
      music: {
        getBot: (id) => (id === 1 ? bot : null),
        virtualServerIdForBot: () => 2,
        loadMediaPermissions: async () => defaultMediaCommandPermissions(),
        idempotency: new MemoryCommandIdempotency(),
      },
    });
    const app = enabledApp({ keys, adapter: runtime.adapter });
    const srv = await listen(app);
    try {
      const unknownGuild = commandBody({ command: 'queue', topLevel: 'queue', guildId: '999' });
      const a = await postInteraction(srv.port, {
        body: unknownGuild,
        signatureHex: keys.sign(TIMESTAMP, unknownGuild),
      });
      assert.equal(a.status, 200);
      assert.match((a.body as any).data.content, /not connected/i);
      assert.doesNotMatch(a.text, new RegExp(SECRET_MARKER));

      const missingBot = commandBody({ command: 'queue', topLevel: 'queue' });
      const b = await postInteraction(srv.port, {
        body: missingBot,
        signatureHex: keys.sign(TIMESTAMP, missingBot),
      });
      assert.equal(b.status, 200);
      assert.match((b.body as any).data.content, /unavailable|configured/i);
      assert.equal(bot.playCalls, 0);
    } finally {
      await srv.close();
    }
  });

  it('10. deferred acknowledgement follows the existing response contract', async () => {
    const keys = ed25519();
    const followUp = new MemoryDiscordFollowUp();
    const body = commandBody({
      command: 'play',
      topLevel: 'play',
      options: [{ name: 'query', type: 3, value: 'https://example.invalid/a' }],
      id: 'ix-play-1',
    });
    let handled = 0;
    const app = enabledApp({
      keys,
      followUp,
      adapter: {
        async handle(intent) {
          handled += 1;
          assert.equal(intent.command, 'play');
          return { ok: true, ephemeral: true, content: 'queued', ack: 'deferred' };
        },
      },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 200);
      assert.equal((res.body as any).type, 5);
      // Ephemeral visibility is fixed on the type-5 ack (flags=64), not on the later PATCH.
      assert.equal((res.body as any).data?.flags, 1 << 6);
      assert.equal(handled, 1);
      for (let i = 0; i < 50 && followUp.jobs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(followUp.jobs.length, 1);
      assert.equal(followUp.jobs[0].command, 'play');
      assert.equal(followUp.jobs[0].result.content, 'queued');
      assert.equal(followUp.jobs[0].interactionId, 'ix-play-1');
    } finally {
      await srv.close();
    }
  });

  it('11. unexpected exceptions do not expose secrets', async () => {
    const keys = ed25519();
    const body = commandBody({ command: 'ts.help' });
    const app = enabledApp({
      keys,
      adapter: {
        async handle() {
          throw new Error(`boom ${SECRET_MARKER}`);
        },
      },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 200);
      assert.equal((res.body as any).type, 4);
      assert.doesNotMatch(res.text, new RegExp(SECRET_MARKER));
      assert.doesNotMatch(res.text, /boom/i);
      assert.match((res.body as any).data.content, /failed/i);
    } finally {
      await srv.close();
    }
  });

  it('12. endpoint disabled by default (config off → not mounted)', async () => {
    const { config } = await import('../config.js');
    assert.equal(config.discordInteractionsEnabled, false);
    // Mirror createApp behaviour when the flag is off: no interactions router.
    const app = express();
    app.use(express.json());
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body: pingBody(),
        signatureHex: '00',
      });
      assert.equal(res.status, 404);
    } finally {
      await srv.close();
    }
  });

  it('misconfigured enabled endpoint fails closed (no unsigned accept)', async () => {
    const app = express();
    app.use('/api/discord/interactions', createDiscordInteractionsMisconfiguredRouter());
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, { body: pingBody(), signatureHex: null });
      assert.equal(res.status, 503);
    } finally {
      await srv.close();
    }
  });

  it('missing adapter fails closed without acknowledging the command', async () => {
    const keys = ed25519();
    const body = commandBody({ command: 'ts.help' });
    const app = enabledApp({ keys, adapter: null });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 503);
      assert.doesNotMatch(res.text, /type\":\s*[45]/);
    } finally {
      await srv.close();
    }
  });

  it('deferred command without interaction token is not type-5 acknowledged', async () => {
    const keys = ed25519();
    let handles = 0;
    const body = commandBody({
      command: 'play',
      topLevel: 'play',
      options: [{ name: 'query', type: 3, value: 'https://example.invalid/a' }],
      token: null,
    });
    const app = enabledApp({
      keys,
      adapter: {
        async handle() {
          handles += 1;
          return { ok: true, ephemeral: true, content: 'queued', ack: 'deferred' };
        },
      },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 503);
      assert.equal(handles, 0);
    } finally {
      await srv.close();
    }
  });

  it('deferred command without follow-up is not type-5 acknowledged', async () => {
    const keys = ed25519();
    let handles = 0;
    const body = commandBody({
      command: 'play',
      topLevel: 'play',
      options: [{ name: 'query', type: 3, value: 'https://example.invalid/a' }],
    });
    const app = enabledApp({
      keys,
      followUp: null,
      adapter: {
        async handle() {
          handles += 1;
          return { ok: true, ephemeral: true, content: 'queued', ack: 'deferred' };
        },
      },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 503);
      assert.equal(handles, 0);
      assert.doesNotMatch(res.text, /type\":\s*5/);
    } finally {
      await srv.close();
    }
  });

  it('deferred type 5 returns before slow handler finishes', async () => {
    const keys = ed25519();
    const followUp = new MemoryDiscordFollowUp();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const body = commandBody({
      command: 'play',
      topLevel: 'play',
      options: [{ name: 'query', type: 3, value: 'https://example.invalid/slow' }],
      id: 'ix-slow',
    });
    const app = enabledApp({
      keys,
      followUp,
      adapter: {
        async handle() {
          await gate;
          return { ok: true, ephemeral: true, content: 'done-late', ack: 'deferred' };
        },
      },
    });
    const srv = await listen(app);
    try {
      const started = Date.now();
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      assert.equal((res.body as any).type, 5);
      assert.ok(elapsed < 200, `type 5 waited on handler (${elapsed}ms)`);
      assert.equal(followUp.jobs.length, 0);
      finish();
      for (let i = 0; i < 50 && followUp.jobs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(followUp.jobs[0]?.result.content, 'done-late');
    } finally {
      finish();
      await srv.close();
    }
  });

  it('follow-up failures are observable without leaking tokens', async () => {
    const keys = ed25519();
    const token = 'interaction-token-SECRET-value';
    const events: Array<{ command: string; guildId: string; reason: string }> = [];
    const body = commandBody({
      command: 'play',
      topLevel: 'play',
      options: [{ name: 'query', type: 3, value: 'https://example.invalid/f' }],
      id: 'ix-fu',
    });
    const app = enabledApp({
      keys,
      onDeliveryError: (info) => events.push(info),
      followUp: {
        async afterDeferred() {
          throw new Error(`webhook failed token=${token}`);
        },
      } as MemoryDiscordFollowUp,
      adapter: {
        async handle() {
          return { ok: true, ephemeral: true, content: 'ok', ack: 'deferred' };
        },
      },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal((res.body as any).type, 5);
      for (let i = 0; i < 50 && events.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.deepEqual(events, [{ command: 'play', guildId: GUILD, reason: 'follow_up_failed' }]);
      assert.doesNotMatch(res.text, new RegExp(token));
      assert.doesNotMatch(JSON.stringify(events), new RegExp(token));
    } finally {
      await srv.close();
    }
  });

  it('deferred handler failure delivers the safe failure with the same job fields', async () => {
    const keys = ed25519();
    const events: Array<{ command: string; guildId: string; reason: string }> = [];
    const followUp = new MemoryDiscordFollowUp();
    const body = commandBody({
      command: 'play',
      topLevel: 'play',
      options: [{ name: 'query', type: 3, value: 'song' }],
      id: 'ix-handler-fail',
    });
    const app = enabledApp({
      keys,
      followUp,
      onDeliveryError: (info) => events.push(info),
      adapter: {
        async handle() {
          throw new Error(`boom ${SECRET_MARKER}`);
        },
      },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal((res.body as any).type, 5);
      for (let i = 0; i < 50 && followUp.jobs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.deepEqual(events, [{ command: 'play', guildId: GUILD, reason: 'handler_failed' }]);
      assert.equal(followUp.jobs.length, 1);
      const delivered = followUp.jobs[0];
      assert.deepEqual(delivered.result, safeCommandFailure());
      assert.equal(delivered.interactionId, 'ix-handler-fail');
      assert.equal(delivered.guildId, GUILD);
      assert.equal(delivered.command, 'play');
      assert.equal(delivered.applicationId, APP_ID);
      assert.equal(delivered.interactionToken, IX_TOKEN);
      assert.equal(delivered.receivedAtMs, NOW_MS);
      assert.doesNotMatch(JSON.stringify(followUp.jobs), new RegExp(SECRET_MARKER));
    } finally {
      await srv.close();
    }
  });

  it('deferred handler and follow-up failures are both reported, in order', async () => {
    const keys = ed25519();
    const events: Array<{ command: string; guildId: string; reason: string }> = [];
    const delivered: unknown[] = [];
    const body = commandBody({
      command: 'play',
      topLevel: 'play',
      options: [{ name: 'query', type: 3, value: 'song' }],
      id: 'ix-both-fail',
    });
    const app = enabledApp({
      keys,
      onDeliveryError: (info) => events.push(info),
      followUp: {
        async afterDeferred(job: unknown) {
          delivered.push(job);
          throw new Error('webhook down');
        },
      } as unknown as MemoryDiscordFollowUp,
      adapter: {
        async handle() {
          throw new Error('handler down');
        },
      },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal((res.body as any).type, 5);
      for (let i = 0; i < 50 && events.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.deepEqual(events, [
        { command: 'play', guildId: GUILD, reason: 'handler_failed' },
        { command: 'play', guildId: GUILD, reason: 'follow_up_failed' },
      ]);
      assert.equal(delivered.length, 1);
    } finally {
      await srv.close();
    }
  });

  it('signature freshness uses trusted nowMs, not request fields', async () => {
    const keys = ed25519();
    const body = pingBody();
    let handles = 0;
    const app = enabledApp({
      keys,
      // Receiver clock far after the signed timestamp → reject as stale.
      nowMs: () => NOW_MS + 120_000,
      adapter: {
        async handle() {
          handles += 1;
          return { ok: true, ephemeral: false, content: '', ack: 'immediate' };
        },
      },
    });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal(res.status, 401);
      assert.equal(handles, 0);
    } finally {
      await srv.close();
    }
  });

  it('createDiscordCommandRuntime does not silently install Memory follow-up', () => {
    const runtime = createDiscordCommandRuntime({
      bindings: new MemoryGuildBindingLookup(),
      policy: { viewerRoleIds: [], adminRoleIds: ['r-admin'] },
      music: {
        getBot: () => null,
        virtualServerIdForBot: () => 2,
        loadMediaPermissions: async () => defaultMediaCommandPermissions(),
        idempotency: new MemoryCommandIdempotency(),
      },
    });
    assert.equal(runtime.followUp, null);
  });

  it('adapter without music still refuses play without side effects', async () => {
    const keys = ed25519();
    const adapter = createDiscordCommandAdapter({
      bindings: { get: () => ({ instanceId: 'i', revoked: false, botId: 1 }) },
      policy: { viewerRoleIds: [], adminRoleIds: ['r-admin'] },
      presence: { async snapshot(_guildId: string) { return null; } },
      bridge: { async health(_guildId: string) { return null; } },
      audit: () => {},
    });
    const body = commandBody({
      command: 'play',
      topLevel: 'play',
      options: [{ name: 'query', type: 3, value: 'https://example.invalid/x' }],
    });
    const followUp = new MemoryDiscordFollowUp();
    const app = enabledApp({ keys, adapter, followUp });
    const srv = await listen(app);
    try {
      const res = await postInteraction(srv.port, {
        body,
        signatureHex: keys.sign(TIMESTAMP, body),
      });
      assert.equal((res.body as any).type, 5);
      for (let i = 0; i < 50 && followUp.jobs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(followUp.jobs[0]?.result.code, 'not_implemented');
    } finally {
      await srv.close();
    }
  });
});

describe('createDiscordCommandRuntime injection boundary', () => {
  it('plugs music-service getBot without requiring VoiceBotManager', async () => {
    const bot = fakeBot();
    const bindings = new MemoryGuildBindingLookup();
    bindings.set(GUILD, { instanceId: 'inst-1', revoked: false, botId: 1 });
    const runtime = createDiscordCommandRuntime({
      bindings,
      policy: { viewerRoleIds: ['r-view'], adminRoleIds: ['r-admin'] },
      music: {
        getBot: (id) => (id === 1 ? bot : null),
        virtualServerIdForBot: () => 2,
        loadMediaPermissions: async () => defaultMediaCommandPermissions(),
        idempotency: new MemoryCommandIdempotency(),
      },
    });
    const result = await runtime.adapter.handle({
      guildId: GUILD,
      userId: 'u-admin',
      roleIds: ['r-admin'],
      memberPermissions: '0',
      command: 'nowplaying',
    });
    assert.equal(result.ok, true);
    assert.ok(createMusicCommandService);
  });
});

describe('F4 Discord interactions split rate limits', () => {
  it('rejects invalid and missing signatures with 401 without consuming auth budget', async () => {
    const keys = ed25519();
    const gates = memoryRateGates({ unauthMax: 50, authMax: 5 });
    const handles: string[] = [];
    const app = enabledApp({
      keys,
      adapter: {
        async handle(intent) {
          handles.push(intent.command);
          return { ok: true, code: 'ok', ephemeral: true, content: 'ok', ack: 'immediate' };
        },
      },
      rateGates: gates,
      replay: new MemoryReplayGuard(),
    });
    const srv = await listen(app);
    try {
      const body = commandBody({ id: 'ix-auth-budget' });
      assert.equal((await postInteraction(srv.port, { body, signatureHex: '00'.repeat(64) })).status, 401);
      assert.equal((await postInteraction(srv.port, { body, signatureHex: null })).status, 401);
      assert.equal(gates.authHits.get('ipv4:127.0.0.1') ?? 0, 0);
      assert.equal(gates.unauthHits.get('ipv4:127.0.0.1'), 2);

      const ok = await postInteraction(srv.port, { body, signatureHex: keys.sign(TIMESTAMP, body) });
      assert.equal(ok.status, 200);
      assert.equal(handles.length, 1);
      assert.equal(gates.authHits.get('ipv4:127.0.0.1'), 1);
    } finally {
      await srv.close();
    }
  });

  it('unsigned floods cannot exhaust the authenticated command budget', async () => {
    const keys = ed25519();
    const gates = memoryRateGates({ unauthMax: 1000, authMax: 3 });
    let handled = 0;
    const app = enabledApp({
      keys,
      adapter: {
        async handle() {
          handled += 1;
          return { ok: true, code: 'ok', ephemeral: true, content: 'ok', ack: 'immediate' };
        },
      },
      rateGates: gates,
      replay: new MemoryReplayGuard(),
    });
    const srv = await listen(app);
    try {
      for (let i = 0; i < 40; i++) {
        const res = await postInteraction(srv.port, {
          body: commandBody({ id: `ix-flood-${i}` }),
          signatureHex: 'ab'.repeat(64),
        });
        assert.equal(res.status, 401);
      }
      assert.equal(gates.authHits.get('ipv4:127.0.0.1') ?? 0, 0);

      for (let i = 0; i < 3; i++) {
        const body = commandBody({ id: `ix-ok-${i}` });
        const res = await postInteraction(srv.port, { body, signatureHex: keys.sign(TIMESTAMP, body) });
        assert.equal(res.status, 200, `signed ${i}`);
      }
      assert.equal(handled, 3);

      const blockedBody = commandBody({ id: 'ix-blocked' });
      const blocked = await postInteraction(srv.port, {
        body: blockedBody,
        signatureHex: keys.sign(TIMESTAMP, blockedBody),
      });
      assert.equal(blocked.status, 429);
      assert.equal(handled, 3);
    } finally {
      await srv.close();
    }
  });

  it('rejects oversized bodies before command work', async () => {
    const keys = ed25519();
    const app = enabledApp({
      keys,
      adapter: {
        async handle() {
          assert.fail('adapter must not run for oversized bodies');
        },
      },
      rateGates: memoryRateGates(),
      replay: new MemoryReplayGuard(),
    });
    app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const status = typeof err === 'object' && err && 'status' in err && typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
      res.status(status).json({ error: 'Rejected.' });
    });
    const srv = await listen(app);
    try {
      const huge = `{"type":2,"id":"ix-huge","pad":"${'x'.repeat(300_000)}"}`;
      const res = await postInteraction(srv.port, {
        body: huge,
        signatureHex: keys.sign(TIMESTAMP, huge),
      });
      assert.equal(res.status, 413);
    } finally {
      await srv.close();
    }
  });

  it('spoofed forwarded headers cannot bypass limits when proxy trust is disabled', async () => {
    const keys = ed25519();
    const { clientRateKey } = await import('../utils/client-address.js');
    const hits = new Map<string, number>();
    const gates: DiscordInteractionRateGates = {
      clientKey: (req) => clientRateKey(req),
      takeUnauthenticated(key) {
        const next = (hits.get(`u:${key}`) ?? 0) + 1;
        hits.set(`u:${key}`, next);
        return next <= 2;
      },
      takeAuthenticated() {
        return true;
      },
    };
    const app = express();
    // Default trust proxy is off — X-Forwarded-For must not mint a fresh key.
    app.use('/api/discord/interactions', createDiscordInteractionsRouter({
      publicKeyHex: keys.publicKeyHex,
      getAdapter: () => ({
        async handle() {
          return { ok: true, code: 'ok', ephemeral: true, content: 'ok', ack: 'immediate' };
        },
      }),
      getFollowUp: () => new MemoryDiscordFollowUp(),
      expectedApplicationId: APP_ID,
      nowMs: () => NOW_MS,
      rateGates: gates,
      replay: new MemoryReplayGuard(),
    }));
    const srv = await listen(app);
    try {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`http://127.0.0.1:${srv.port}/api/discord/interactions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature-ed25519': 'ab'.repeat(64),
            'x-signature-timestamp': TIMESTAMP,
            'x-forwarded-for': `198.51.100.${i}`,
          },
          body: commandBody({ id: `ix-xff-${i}` }),
        });
        assert.equal(res.status, 401);
      }
      const blocked = await fetch(`http://127.0.0.1:${srv.port}/api/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': 'ab'.repeat(64),
          'x-signature-timestamp': TIMESTAMP,
          'x-forwarded-for': '203.0.113.9',
        },
        body: commandBody({ id: 'ix-xff-blocked' }),
      });
      assert.equal(blocked.status, 429);
      assert.equal(hits.size, 1);
    } finally {
      await srv.close();
    }
  });

  it('misconfigured feature stays fail-closed and rate-limits abuse', async () => {
    const gates = memoryRateGates({ unauthMax: 2, authMax: 100 });
    const app = express();
    app.use('/api/discord/interactions', createDiscordInteractionsMisconfiguredRouter(gates));
    const srv = await listen(app);
    try {
      assert.equal((await postInteraction(srv.port, { body: '{}', signatureHex: null })).status, 503);
      assert.equal((await postInteraction(srv.port, { body: '{}', signatureHex: null })).status, 503);
      assert.equal((await postInteraction(srv.port, { body: '{}', signatureHex: null })).status, 429);
    } finally {
      await srv.close();
    }
  });
});

describe('F7 Discord interaction-id replay claims', () => {
  it('executes a valid signed interaction once; duplicates skip side effects', async () => {
    const keys = ed25519();
    const replay = new MemoryReplayGuard(60_000);
    let handled = 0;
    const app = enabledApp({
      keys,
      adapter: {
        async handle() {
          handled += 1;
          return { ok: true, code: 'ok', ephemeral: true, content: `n=${handled}`, ack: 'immediate' };
        },
      },
      replay,
      rateGates: memoryRateGates(),
    });
    const srv = await listen(app);
    try {
      const body = commandBody({ id: 'ix-once' });
      const sig = keys.sign(TIMESTAMP, body);
      const first = await postInteraction(srv.port, { body, signatureHex: sig });
      const second = await postInteraction(srv.port, { body, signatureHex: sig });
      assert.equal(first.status, 200);
      assert.equal((first.body as any).data?.content, 'n=1');
      assert.equal(second.status, 200);
      assert.match(String((second.body as any).data?.content ?? ''), /Duplicate/);
      assert.equal(handled, 1);
    } finally {
      await srv.close();
    }
  });

  it('concurrent duplicates execute at most once', async () => {
    const keys = ed25519();
    const replay = new MemoryReplayGuard(60_000);
    let handled = 0;
    const app = enabledApp({
      keys,
      adapter: {
        async handle() {
          handled += 1;
          await new Promise((r) => setTimeout(r, 20));
          return { ok: true, code: 'ok', ephemeral: true, content: 'ok', ack: 'immediate' };
        },
      },
      replay,
    });
    const srv = await listen(app);
    try {
      const body = commandBody({ id: 'ix-concurrent' });
      const sig = keys.sign(TIMESTAMP, body);
      const results = await Promise.all(Array.from({ length: 8 }, () =>
        postInteraction(srv.port, { body, signatureHex: sig })));
      assert.equal(handled, 1);
      assert.equal(results.filter((r) => String((r.body as any).data?.content ?? '').includes('Duplicate')).length, 7);
    } finally {
      await srv.close();
    }
  });

  it('keeps blocking after a short result-cache window while the signature remains valid', async () => {
    const keys = ed25519();
    const maxAgeMs = 60_000;
    const replay = new MemoryReplayGuard(maxAgeMs);
    let handled = 0;
    let now = NOW_MS;
    const app = express();
    app.locals.discordCommandAdapter = {
      async handle() {
        handled += 1;
        return { ok: true, code: 'ok', ephemeral: true, content: 'ok', ack: 'immediate' };
      },
    };
    app.locals.discordInteractionFollowUp = new MemoryDiscordFollowUp();
    app.use('/api/discord/interactions', createDiscordInteractionsRouter({
      publicKeyHex: keys.publicKeyHex,
      getAdapter: (req) => req.app.locals.discordCommandAdapter ?? null,
      getFollowUp: (req) => req.app.locals.discordInteractionFollowUp ?? null,
      expectedApplicationId: APP_ID,
      nowMs: () => now,
      maxAgeMs,
      replay,
    }));
    const srv = await listen(app);
    try {
      const body = commandBody({ id: 'ix-long-claim' });
      const sig = keys.sign(TIMESTAMP, body);
      assert.equal((await postInteraction(srv.port, { body, signatureHex: sig })).status, 200);
      assert.equal(handled, 1);
      // Past a typical short result-cache window but still inside the signature window.
      now = NOW_MS + 30_000;
      const replayed = await postInteraction(srv.port, { body, signatureHex: sig });
      assert.match(String((replayed.body as any).data?.content ?? ''), /Duplicate/);
      assert.equal(handled, 1);
      now = NOW_MS + maxAgeMs + 1;
      const expired = await postInteraction(srv.port, { body, signatureHex: sig });
      assert.equal(expired.status, 401);
      assert.equal(handled, 1);
    } finally {
      await srv.close();
    }
  });

  it('invalid signatures do not claim interaction ids', async () => {
    const keys = ed25519();
    const replay = new MemoryReplayGuard(60_000);
    let handled = 0;
    const app = enabledApp({
      keys,
      adapter: {
        async handle() {
          handled += 1;
          return { ok: true, code: 'ok', ephemeral: true, content: 'ok', ack: 'immediate' };
        },
      },
      replay,
    });
    const srv = await listen(app);
    try {
      const body = commandBody({ id: 'ix-no-claim-on-bad-sig' });
      assert.equal((await postInteraction(srv.port, { body, signatureHex: 'cd'.repeat(64) })).status, 401);
      assert.equal(replay.size(), 0);
      const ok = await postInteraction(srv.port, { body, signatureHex: keys.sign(TIMESTAMP, body) });
      assert.equal(ok.status, 200);
      assert.equal(handled, 1);
      assert.equal(replay.size(), 1);
    } finally {
      await srv.close();
    }
  });

  it('deferred duplicates do not double-ack or re-run follow-up side effects', async () => {
    const keys = ed25519();
    const replay = new MemoryReplayGuard(60_000);
    let handled = 0;
    const followUp = new MemoryDiscordFollowUp();
    const app = enabledApp({
      keys,
      adapter: {
        async handle() {
          handled += 1;
          return { ok: true, code: 'ok', ephemeral: true, content: 'played', ack: 'deferred' };
        },
      },
      followUp,
      replay,
    });
    const srv = await listen(app);
    try {
      const body = commandBody({
        id: 'ix-deferred-once',
        command: 'play',
        topLevel: 'play',
        options: [{ name: 'query', type: 3, value: 'https://example.invalid/a' }],
      });
      const sig = keys.sign(TIMESTAMP, body);
      const first = await postInteraction(srv.port, { body, signatureHex: sig });
      assert.equal((first.body as any).type, 5);
      for (let i = 0; i < 50 && followUp.jobs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(followUp.jobs.length, 1);
      assert.equal(handled, 1);

      const second = await postInteraction(srv.port, { body, signatureHex: sig });
      assert.notEqual((second.body as any).type, 5);
      assert.match(String((second.body as any).data?.content ?? ''), /Duplicate/);
      assert.equal(handled, 1);
      assert.equal(followUp.jobs.length, 1);
    } finally {
      await srv.close();
    }
  });

  it('bounded replay cache fails closed when full', async () => {
    const keys = ed25519();
    const replay = new MemoryReplayGuard(60_000, 2);
    let handled = 0;
    const app = enabledApp({
      keys,
      adapter: {
        async handle() {
          handled += 1;
          return { ok: true, code: 'ok', ephemeral: true, content: 'ok', ack: 'immediate' };
        },
      },
      replay,
    });
    const srv = await listen(app);
    try {
      for (const id of ['ix-a', 'ix-b']) {
        const body = commandBody({ id });
        assert.equal((await postInteraction(srv.port, {
          body,
          signatureHex: keys.sign(TIMESTAMP, body),
        })).status, 200);
      }
      assert.equal(handled, 2);
      const body = commandBody({ id: 'ix-c' });
      const full = await postInteraction(srv.port, { body, signatureHex: keys.sign(TIMESTAMP, body) });
      assert.match(String((full.body as any).data?.content ?? ''), /Duplicate/);
      assert.equal(handled, 2);
    } finally {
      await srv.close();
    }
  });
});
