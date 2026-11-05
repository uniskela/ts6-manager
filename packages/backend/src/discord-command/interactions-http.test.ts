import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { defaultMediaCommandPermissions } from '../voice/media-command-permissions.js';
import { PlayQueue, type QueueItem } from '../voice/playlist/queue.js';
import { createDiscordCommandAdapter, type DiscordCommandIntent } from './adapter.js';
import { MemoryDiscordFollowUp } from './follow-up.js';
import {
  createDiscordInteractionsMisconfiguredRouter,
  createDiscordInteractionsRouter,
  isValidDiscordPublicKeyHex,
} from './interactions-http.js';
import { MemoryCommandIdempotency } from './idempotency.js';
import { createMusicCommandService } from './music-service.js';
import { createDiscordCommandRuntime, MemoryGuildBindingLookup } from './runtime.js';

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

function enabledApp(opts: {
  keys: ReturnType<typeof ed25519>;
  adapter: { handle(intent: DiscordCommandIntent): Promise<any> } | null;
  /** Omit to inject Memory stub; pass null to simulate missing follow-up. */
  followUp?: MemoryDiscordFollowUp | null;
  expectedApplicationId?: string | null;
  nowMs?: () => number;
  onDeliveryError?: (info: { command: string; guildId: string; reason: string }) => void;
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
        async snapshot() {
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
      presence: { async snapshot() { return null; } },
      bridge: { async health() { return null; } },
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
