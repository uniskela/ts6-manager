/**
 * Step 4A application-composition smoke (not a full production startup proof).
 *
 * Exercises the same pieces createApp + index.ts wire together:
 *   createDiscordInteractionsRouter + installDiscordCommandRuntime
 *   + Prisma guild bindings + authorising music execute + webhook follow-up.
 *
 * Uses isolated temp SQLite, synthetic Ed25519 interactions, a fake
 * VoiceBotManager, and a mocked Discord webhook transport (localhost only).
 * Does not boot VoiceBotManager.start(), BotEngine, or live TeamSpeak/Discord.
 * DISCORD_INTERACTIONS_ENABLED must remain off in this process.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { defaultMediaCommandPermissions } from '../voice/media-command-permissions.js';
import { PlayQueue, type QueueItem } from '../voice/playlist/queue.js';
import {
  clearDiscordCommandRuntime,
  createAuthorisingMusicExecute,
  createBackendDiscordCommandRuntime,
  createInstanceScopedBindingLookup,
  installDiscordCommandRuntime,
  type VoiceBotManagerPort,
} from './backend-runtime.js';
import { createDiscordCommandAdapter } from './adapter.js';
import { createDiscordGuildBindingService, createPrismaGuildBindingLookup } from './guild-bindings.js';
import { createDiscordWebhookFollowUp } from './discord-delivery.js';
import {
  createDiscordInteractionsMisconfiguredRouter,
  createDiscordInteractionsRouter,
} from './interactions-http.js';
import { MemoryCommandIdempotency } from './idempotency.js';
import { createMusicCommandService } from './music-service.js';
import { config } from '../config.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../../generated/prisma/index.js') as typeof import('../../generated/prisma/index.js');
const prismaCli = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

const NOW_MS = 1_700_000_000_000;
const TIMESTAMP = '1700000000';
const GUILD = '111000000000000001';
const OTHER = '222000000000000002';
const APP_ID = '999000000000000001';
const VIEWER = 'r-view';
const ADMIN = 'r-admin';
const INSTANCE = 'inst-4a';
const IX_TOKEN = 'smoke-interaction-token';

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    sign(timestamp: string, body: string) {
      return sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex');
    },
  };
}

async function openDb() {
  const root = await mkdtemp(path.join(tmpdir(), 'ts6-4a-smoke-'));
  const url = `file:${path.join(root, 'test.db')}?connection_limit=1`;
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.tsServerConfig.create({ data: { id: 1, name: 'Lab', host: 'lab.test', apiKey: 'x' } });
  await prisma.musicBot.create({ data: { id: 10, serverConfigId: 1, name: 'LabBot', virtualServerId: 1 } });
  return { root, prisma };
}

function track(id: string): QueueItem {
  return {
    id,
    title: id,
    artist: 'A',
    filePath: `/tmp/${id}`,
    source: 'url',
    sourceUrl: `https://example.invalid/${id}`,
  };
}

function fakeBot(id: number, serverConfigId: number) {
  const bot: any = {
    currentConfig: { id, serverConfigId, serverPort: 10011, volume: 40, name: `Bot${id}` },
    status: 'connected',
    nowPlaying: null,
    isStreaming: false,
    stopGeneration: 0,
    playbackProgress: { position: 0, duration: 0 },
    queue: new PlayQueue(),
    playCalls: 0,
    stopCalls: 0,
    assertMusicCanStart: () => {},
    pause() {},
    resume() {},
    stopAudio() {
      bot.stopCalls += 1;
      bot.nowPlaying = null;
      bot.status = 'connected';
    },
    applyVolume: async (volume: number) => { bot.currentConfig.volume = volume; },
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

function fakeManager(bots: Map<number, any>): VoiceBotManagerPort & { bots: Map<number, any> } {
  return { bots, getBot(id: number) { return bots.get(id); } };
}

async function listen(app: Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function post(
  port: number,
  body: string,
  keys: ReturnType<typeof ed25519>,
  opts: { badSig?: boolean; omitSig?: boolean } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!opts.omitSig) {
    headers['x-signature-timestamp'] = TIMESTAMP;
    headers['x-signature-ed25519'] = opts.badSig ? '00'.repeat(64) : keys.sign(TIMESTAMP, body);
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/discord/interactions`, {
    method: 'POST',
    headers,
    body,
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep */ }
  return { status: res.status, body: json, text };
}

function cmdBody(partial: {
  name: string;
  guildId?: string;
  roles?: string[];
  options?: unknown[];
  applicationId?: string;
  id?: string;
  token?: string;
}) {
  return JSON.stringify({
    type: 2,
    id: partial.id ?? `ix-${partial.name}-${Math.random().toString(16).slice(2, 8)}`,
    application_id: partial.applicationId ?? APP_ID,
    token: partial.token ?? IX_TOKEN,
    guild_id: partial.guildId ?? GUILD,
    member: {
      user: { id: 'u1' },
      roles: partial.roles ?? [VIEWER, ADMIN],
      permissions: '0',
    },
    data: { name: partial.name, options: partial.options ?? [] },
  });
}

describe('Step 4A integration preflight smoke', () => {
  it('covers signed Express pipeline with isolated SQLite + fake VoiceBotManager', async () => {
    assert.equal(config.discordInteractionsEnabled, false, 'flag must stay off in this process');

    const { root, prisma } = await openDb();
    const keys = ed25519();
    const bot = fakeBot(10, 1);
    const manager = fakeManager(new Map([[10, bot]]));
    const webhookHits: Array<{ method: string; url: string }> = [];
    let ackBeforePlay = false;
    let playCompleted = false;

    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({
        guildId: GUILD,
        instanceId: INSTANCE,
        serverConfigId: 1,
        musicBotId: 10,
      });

      // Production-shaped music wiring with stubbed media I/O (no TS/Discord egress).
      const bindings = createInstanceScopedBindingLookup(
        createPrismaGuildBindingLookup(prisma as any),
        INSTANCE,
      );
      const baseMusic = createMusicCommandService({
        getBot: (id) => manager.getBot(id) ?? null,
        virtualServerIdForBot: () => 1,
        loadMediaPermissions: async () => defaultMediaCommandPermissions(),
        validateUrl: async () => ({ valid: true }),
        pipeline: {
          resolveSpotify: async (url) => url,
          resolveAppleMusic: async () => ({ tracks: [] }),
          resolveSpotifyCollection: async () => null,
          appleTrackToYouTube: async () => null,
          expandYouTube: async () => null,
          downloadTrack: async () => track('smoke'),
        },
        idempotency: new MemoryCommandIdempotency(),
        nowMs: () => NOW_MS,
      });
      const music = createAuthorisingMusicExecute(bindings, baseMusic, manager);
      const adapter = createDiscordCommandAdapter({
        bindings,
        policy: { viewerRoleIds: [VIEWER], adminRoleIds: [ADMIN] },
        presence: { async snapshot(_guildId: string) { return null; } },
        bridge: { async health(_guildId: string) { return null; } },
        audit: () => {},
        music,
        nowMs: () => NOW_MS,
      });

      const followUp = createDiscordWebhookFollowUp({
        applicationId: APP_ID,
        apiBaseUrl: 'http://127.0.0.1:9', // never used — transport intercepts
        transport: {
          async fetch(url, init) {
            const method = init?.method ?? 'GET';
            webhookHits.push({ method, url });
            assert.match(url, /^http:\/\/127\.0\.0\.1/);
            assert.doesNotMatch(url, /discord\.com/);
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
          },
        },
        nowMs: () => NOW_MS,
      });

      const app = express();
      installDiscordCommandRuntime(app, { adapter, followUp, bindings });
      // Mirror createApp when enabled + valid public key.
      app.use('/api/discord/interactions', createDiscordInteractionsRouter({
        publicKeyHex: keys.publicKeyHex,
        getAdapter: (req) => req.app.locals.discordCommandAdapter ?? null,
        getFollowUp: (req) => req.app.locals.discordInteractionFollowUp ?? null,
        expectedApplicationId: APP_ID,
        nowMs: () => NOW_MS,
      }));

      const srv = await listen(app);
      try {
        // 1. Signed PING
        const ping = JSON.stringify({ type: 1 });
        const p1 = await post(srv.port, ping, keys);
        assert.equal(p1.status, 200);
        assert.equal((p1.body as any).type, 1);

        // 2. Invalid signature
        const p2 = await post(srv.port, ping, keys, { badSig: true });
        assert.equal(p2.status, 401);

        // 3. Wrong application ID (deferred path)
        const wrongApp = cmdBody({
          name: 'play',
          applicationId: '888000000000000001',
          options: [{ name: 'query', type: 3, value: 'https://example.invalid/x.mp3' }],
          id: 'ix-wrong-app',
        });
        const p3 = await post(srv.port, wrongApp, keys);
        assert.equal(p3.status, 401);
        assert.equal(bot.playCalls, 0);

        // 4. Unknown guild
        const unk = cmdBody({ name: 'queue', guildId: OTHER, id: 'ix-unk' });
        const p4 = await post(srv.port, unk, keys);
        assert.equal(p4.status, 200);
        assert.match((p4.body as any).data.content, /not connected/i);

        // 5. Revoked guild
        await svc.revoke(GUILD);
        const rev = cmdBody({ name: 'queue', id: 'ix-rev' });
        const p5 = await post(srv.port, rev, keys);
        assert.equal(p5.status, 200);
        assert.match((p5.body as any).data.content, /not connected/i);
        await svc.bind({
          guildId: GUILD,
          instanceId: INSTANCE,
          serverConfigId: 1,
          musicBotId: 10,
        });

        // 6. Authorised guild resolves exact bot via /queue
        const q = cmdBody({ name: 'queue', id: 'ix-q' });
        const p6 = await post(srv.port, q, keys);
        assert.equal(p6.status, 200);
        assert.match((p6.body as any).data.content, /empty|queue/i);

        // 10 + 7 + 11: deferred type-5 before play; routes into music; webhook mock
        const playBody = cmdBody({
          name: 'play',
          options: [{ name: 'query', type: 3, value: 'https://example.invalid/a.mp3' }],
          id: 'ix-play',
          token: 'play-token-1',
        });
        const playPromise = post(srv.port, playBody, keys).then((res) => {
          ackBeforePlay = res.status === 200 && (res.body as any).type === 5;
          assert.equal((res.body as any).type, 5);
          return res;
        });
        const playRes = await playPromise;
        assert.equal(playRes.status, 200);
        // Wait for deferred follow-up
        for (let i = 0; i < 50 && webhookHits.length === 0; i += 1) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(ackBeforePlay, true);
        assert.ok(bot.playCalls >= 1, 'play must hit fake bot');
        playCompleted = bot.playCalls >= 1;
        assert.ok(webhookHits.some((h) => h.method === 'PATCH'));
        assert.ok(webhookHits.every((h) => {
          try {
            const host = new URL(h.url, 'http://127.0.0.1').hostname.toLowerCase();
            return host !== 'discord.com' && !host.endsWith('.discord.com');
          } catch {
            return true;
          }
        }));

        // 8. /stop same bot + queue
        const beforeStop = bot.stopCalls;
        const stopBody = cmdBody({ name: 'stop', id: 'ix-stop' });
        const p8 = await post(srv.port, stopBody, keys);
        assert.equal(p8.status, 200);
        assert.ok(bot.stopCalls > beforeStop);
        assert.equal(bot.nowPlaying, null);

        // 9. Missing / reassigned bot refused
        manager.bots.delete(10);
        const miss = cmdBody({ name: 'queue', id: 'ix-miss' });
        const p9 = await post(srv.port, miss, keys);
        assert.equal(p9.status, 200);
        assert.match((p9.body as any).data.content, /unavailable/i);
        const otherBot = fakeBot(10, 2); // wrong serverConfigId
        manager.bots.set(10, otherBot);
        const reassign = cmdBody({ name: 'queue', id: 'ix-re' });
        const p9b = await post(srv.port, reassign, keys);
        assert.equal(p9b.status, 200);
        assert.match((p9b.body as any).data.content, /unavailable/i);
        manager.bots.set(10, bot);

        // 12. Public errors sanitised (unknown command)
        const bad = cmdBody({ name: 'notacommand', id: 'ix-bad' });
        const p12 = await post(srv.port, bad, keys);
        assert.equal(p12.status, 200);
        assert.doesNotMatch(p12.text, /prisma|ECONNREFUSED|stack|SECRET/i);
        assert.match((p12.body as any).data.content, /Unknown command/i);

        // 14. No external Discord/TS — webhook only hit localhost mock; bot is fake
        assert.ok(webhookHits.every((h) => h.url.startsWith('http://127.0.0.1')));
        assert.ok(playCompleted);
      } finally {
        await srv.close();
        clearDiscordCommandRuntime(app);
      }

      // 13. Incomplete configuration cannot execute commands
      const mis = express();
      // Production createBackend path without follow-up → deferred 503
      const rt = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        voiceBotManager: manager,
        instanceId: INSTANCE,
        policy: { viewerRoleIds: [VIEWER], adminRoleIds: [ADMIN] },
      });
      installDiscordCommandRuntime(mis, rt);
      mis.use('/api/discord/interactions', createDiscordInteractionsRouter({
        publicKeyHex: keys.publicKeyHex,
        getAdapter: (req) => req.app.locals.discordCommandAdapter ?? null,
        getFollowUp: (req) => req.app.locals.discordInteractionFollowUp ?? null,
        expectedApplicationId: APP_ID,
        nowMs: () => NOW_MS,
      }));
      const s2 = await listen(mis);
      try {
        const body = cmdBody({
          name: 'play',
          options: [{ name: 'query', type: 3, value: 'https://example.invalid/b.mp3' }],
          id: 'ix-nofollow',
        });
        const r = await post(s2.port, body, keys);
        assert.equal(r.status, 503);

        // Misconfigured public key router
        const mis2 = express();
        mis2.use('/api/discord/interactions', createDiscordInteractionsMisconfiguredRouter());
        const s3 = await listen(mis2);
        try {
          const r2 = await post(s3.port, JSON.stringify({ type: 1 }), keys);
          assert.equal(r2.status, 503);
        } finally {
          await s3.close();
        }
      } finally {
        await s2.close();
        clearDiscordCommandRuntime(mis);
      }
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });
});
