import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import express, { type Express } from 'express';
import { PlayQueue } from '../voice/playlist/queue.js';
import {
  clearDiscordCommandRuntime,
  createAuthorisingMusicExecute,
  createBackendDiscordCommandRuntime,
  createInstanceScopedBindingLookup,
  installDiscordCommandRuntime,
  resolveBotForBinding,
  type VoiceBotManagerPort,
} from './backend-runtime.js';
import { createDiscordGuildBindingService, createPrismaGuildBindingLookup } from './guild-bindings.js';
import { createDiscordInteractionsRouter } from './interactions-http.js';
import { MemoryDiscordFollowUp } from './follow-up.js';
import { generateKeyPairSync, sign } from 'node:crypto';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../../generated/prisma/index.js') as typeof import('../../generated/prisma/index.js');
const prismaCli = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

const GUILD = '111000000000000001';
const OTHER = '222000000000000002';
const VIEWER = 'r-view';
const ADMIN = 'r-admin';
const INSTANCE = 'inst-local';
const NOW_MS = 1_700_000_000_000;
const TIMESTAMP = '1700000000';

async function openDb() {
  const root = await mkdtemp(path.join(tmpdir(), 'ts6-discord-rt-'));
  const url = `file:${path.join(root, 'test.db')}?connection_limit=1`;
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.tsServerConfig.create({ data: { id: 1, name: 'One', host: 'one.test', apiKey: 'x' } });
  await prisma.tsServerConfig.create({ data: { id: 2, name: 'Two', host: 'two.test', apiKey: 'x' } });
  await prisma.musicBot.create({ data: { id: 10, serverConfigId: 1, name: 'Bot1', virtualServerId: 1 } });
  await prisma.musicBot.create({ data: { id: 11, serverConfigId: 1, name: 'Bot1b', virtualServerId: 1 } });
  await prisma.musicBot.create({ data: { id: 20, serverConfigId: 2, name: 'Bot2', virtualServerId: 1 } });
  return { root, prisma, url };
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
    assertMusicCanStart: () => {},
    pause() {},
    resume() {},
    stopAudio() {
      bot.nowPlaying = null;
      bot.status = 'connected';
    },
    applyVolume: async (volume: number) => {
      bot.currentConfig.volume = volume;
    },
    play: async (item: unknown) => {
      bot.playCalls += 1;
      bot.nowPlaying = item;
      bot.status = 'playing';
    },
    playStream: async (item: unknown) => {
      bot.playCalls += 1;
      bot.nowPlaying = item;
      bot.status = 'playing';
    },
  };
  return bot;
}

function fakeManager(bots: Map<number, any>): VoiceBotManagerPort & { bots: Map<number, any> } {
  return {
    bots,
    getBot(id: number) {
      return bots.get(id);
    },
  };
}

function policy() {
  return { viewerRoleIds: [VIEWER], adminRoleIds: [ADMIN] };
}

function intent(command: string, guildId = GUILD) {
  return {
    guildId,
    userId: 'u1',
    roleIds: [VIEWER],
    memberPermissions: '0',
    command,
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

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    sign(timestamp: string, body: string) {
      return sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex');
    },
  };
}

describe('Discord backend runtime wiring (Phase 2C step 3A)', () => {
  it('1. valid persisted binding resolves the expected bot', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: INSTANCE, serverConfigId: 1, musicBotId: 10 });
      const bot = fakeBot(10, 1);
      const manager = fakeManager(new Map([[10, bot], [11, fakeBot(11, 1)]]));
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        voiceBotManager: manager,
        instanceId: INSTANCE,
        policy: policy(),
      });
      assert.ok(runtime);
      const result = await runtime!.adapter.handle(intent('nowplaying'));
      assert.equal(result.ok, true);
      assert.equal(bot.playCalls, 0);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('2. unknown guild is refused', async () => {
    const { root, prisma } = await openDb();
    try {
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        voiceBotManager: fakeManager(new Map()),
        instanceId: INSTANCE,
        policy: policy(),
      });
      const result = await runtime!.adapter.handle(intent('nowplaying', OTHER));
      assert.equal(result.code, 'unpaired');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('3. revoked guild is refused', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: INSTANCE, serverConfigId: 1, musicBotId: 10 });
      await svc.revoke(GUILD);
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        voiceBotManager: fakeManager(new Map([[10, fakeBot(10, 1)]])),
        instanceId: INSTANCE,
        policy: policy(),
      });
      const result = await runtime!.adapter.handle(intent('nowplaying'));
      assert.equal(result.code, 'unpaired');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('4. missing bot is refused', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: INSTANCE, serverConfigId: 1, musicBotId: 10 });
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        voiceBotManager: fakeManager(new Map()),
        instanceId: INSTANCE,
        policy: policy(),
      });
      const result = await runtime!.adapter.handle(intent('nowplaying'));
      assert.equal(result.code, 'unavailable');
      assert.match(result.content, /unavailable/i);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('5. bot moved to another server is refused', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: INSTANCE, serverConfigId: 1, musicBotId: 10 });
      // Live bot reports serverConfigId 2 while binding authorises server 1.
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        voiceBotManager: fakeManager(new Map([[10, fakeBot(10, 2)]])),
        instanceId: INSTANCE,
        policy: policy(),
      });
      const result = await runtime!.adapter.handle(intent('nowplaying'));
      assert.equal(result.code, 'unavailable');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('6. incorrect instance is refused', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: 'other-instance', serverConfigId: 1, musicBotId: 10 });
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        voiceBotManager: fakeManager(new Map([[10, fakeBot(10, 1)]])),
        instanceId: INSTANCE,
        policy: policy(),
      });
      const result = await runtime!.adapter.handle(intent('nowplaying'));
      assert.equal(result.code, 'unpaired');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('7. no fallback bot is selected', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: INSTANCE, serverConfigId: 1, musicBotId: 10 });
      const other = fakeBot(11, 1);
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        // Expected bot 10 missing; sibling bot 11 present — must not remapped.
        voiceBotManager: fakeManager(new Map([[11, other]])),
        instanceId: INSTANCE,
        policy: policy(),
      });
      const result = await runtime!.adapter.handle(intent('nowplaying'));
      assert.equal(result.code, 'unavailable');
      assert.equal(other.playCalls, 0);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('8. bot manager unavailable produces a controlled error', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: INSTANCE, serverConfigId: 1, musicBotId: 10 });
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        voiceBotManager: null,
        instanceId: INSTANCE,
        policy: policy(),
      });
      assert.ok(runtime);
      const result = await runtime!.adapter.handle(intent('nowplaying'));
      assert.equal(result.code, 'unavailable');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('9. Prisma unavailable produces a controlled error', async () => {
    const throwingPrisma = {
      discordGuildBinding: {
        findUnique: async () => { throw new Error('SQLITE_ERROR: disk I/O'); },
        upsert: async () => { throw new Error('no'); },
        update: async () => { throw new Error('no'); },
      },
      musicBot: { findUnique: async () => null },
      tsServerConfig: { findUnique: async () => null },
      appSetting: { findUnique: async () => null },
    };
    const runtime = createBackendDiscordCommandRuntime({
      prisma: throwingPrisma as any,
      voiceBotManager: fakeManager(new Map()),
      instanceId: INSTANCE,
      policy: policy(),
    });
    assert.ok(runtime);
    const result = await runtime!.adapter.handle(intent('ts.help'));
    assert.equal(result.code, 'unavailable');
    assert.doesNotMatch(result.content, /SQLITE|disk I\/O/i);
  });

  it('10. backend restart reconstructs deps without losing persisted binding', async () => {
    const { root, prisma, url } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: INSTANCE, serverConfigId: 1, musicBotId: 10 });
      await prisma.$disconnect();

      const prisma2 = new PrismaClient({ datasources: { db: { url } } });
      const manager2 = fakeManager(new Map([[10, fakeBot(10, 1)]]));
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma2 as any,
        voiceBotManager: manager2,
        instanceId: INSTANCE,
        policy: policy(),
      });
      const result = await runtime!.adapter.handle(intent('nowplaying'));
      assert.equal(result.ok, true);
      await prisma2.$disconnect();
    } finally {
      await prisma.$disconnect().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('11. disabled interactions endpoint remains disabled (createApp contract)', async () => {
    const { config } = await import('../config.js');
    assert.equal(config.discordInteractionsEnabled, false);
    // Mirror createApp when the flag is off: no interactions router mounted.
    // (Avoid importing createApp here — it mkdir's MUSIC_DIR at load time.)
    const app = express();
    app.use(express.json());
    const bot = fakeBot(10, 1);
    const runtime = createBackendDiscordCommandRuntime({
      prisma: {
        discordGuildBinding: { findUnique: async () => null, upsert: async () => { throw new Error('no'); }, update: async () => { throw new Error('no'); } },
        musicBot: { findUnique: async () => null },
        tsServerConfig: { findUnique: async () => null },
        appSetting: { findUnique: async () => null },
      } as any,
      voiceBotManager: fakeManager(new Map([[10, bot]])),
      instanceId: INSTANCE,
      policy: policy(),
    });
    installDiscordCommandRuntime(app, runtime);
    assert.ok(app.locals.discordCommandAdapter);
    assert.equal(app.locals.discordInteractionFollowUp, null);
    const srv = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/discord/interactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 1 }),
      });
      assert.equal(res.status, 404);
      assert.equal(bot.playCalls, 0);
    } finally {
      await srv.close();
      clearDiscordCommandRuntime(app);
    }
  });

  it('12. incomplete deferred follow-up cannot acknowledge unsupported commands', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: INSTANCE, serverConfigId: 1, musicBotId: 10 });
      const bot = fakeBot(10, 1);
      const runtime = createBackendDiscordCommandRuntime({
        prisma: prisma as any,
        voiceBotManager: fakeManager(new Map([[10, bot]])),
        instanceId: INSTANCE,
        policy: policy(),
        // followUp omitted → null
      });
      assert.equal(runtime!.followUp, null);

      const keys = ed25519();
      const app = express();
      installDiscordCommandRuntime(app, runtime);
      app.use('/api/discord/interactions', createDiscordInteractionsRouter({
        publicKeyHex: keys.publicKeyHex,
        getAdapter: (req) => req.app.locals.discordCommandAdapter ?? null,
        getFollowUp: (req) => req.app.locals.discordInteractionFollowUp ?? null,
        nowMs: () => NOW_MS,
      }));
      const body = JSON.stringify({
        type: 2,
        id: 'ix-play',
        guild_id: GUILD,
        member: { user: { id: 'u1' }, roles: [VIEWER], permissions: '0' },
        data: { name: 'play', options: [{ name: 'query', type: 3, value: 'never-play' }] },
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
        assert.equal(res.status, 503);
        assert.equal(bot.playCalls, 0);
      } finally {
        await srv.close();
      }
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('13. runtime initialization produces no playback or Discord side effects', async () => {
    const bot = fakeBot(10, 1);
    const manager = fakeManager(new Map([[10, bot]]));
    const runtime = createBackendDiscordCommandRuntime({
      prisma: {
        discordGuildBinding: { findUnique: async () => null, upsert: async () => { throw new Error('no'); }, update: async () => { throw new Error('no'); } },
        musicBot: { findUnique: async () => null },
        tsServerConfig: { findUnique: async () => null },
        appSetting: { findUnique: async () => null },
      } as any,
      voiceBotManager: manager,
      instanceId: INSTANCE,
      policy: policy(),
    });
    assert.ok(runtime);
    assert.equal(runtime!.followUp, null);
    assert.equal(bot.playCalls, 0);
    assert.equal(bot.status, 'connected');
    // Memory follow-up must not be auto-selected.
    assert.equal(runtime!.followUp instanceof MemoryDiscordFollowUp, false);
  });

  it('revocation while preparing music refuses the side effect (auth boundary)', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({ guildId: GUILD, instanceId: INSTANCE, serverConfigId: 1, musicBotId: 10 });
      const bot = fakeBot(10, 1);
      const bindings = createInstanceScopedBindingLookup(
        createPrismaGuildBindingLookup(prisma as any),
        INSTANCE,
      );
      const inner = {
        async execute() {
          bot.playCalls += 1;
          return { ok: true, ephemeral: true, content: 'played', ack: 'immediate' as const };
        },
      };
      const wrapped = createAuthorisingMusicExecute(
        bindings,
        inner,
        fakeManager(new Map([[10, bot]])),
      );

      // Adapter-style: binding loaded, then revoked before music side effect.
      const first = await bindings.get(GUILD);
      assert.ok(first && !first.revoked);
      await svc.revoke(GUILD);
      const refused = await wrapped.execute(intent('pause'), first);
      assert.equal(refused.code, 'unpaired');
      assert.equal(bot.playCalls, 0);

      assert.equal(resolveBotForBinding(fakeManager(new Map([[10, fakeBot(10, 2)]])), {
        instanceId: INSTANCE,
        revoked: false,
        botId: 10,
        serverConfigId: 1,
      }), null);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('incomplete runtime (empty instanceId) is not installed', () => {
    const runtime = createBackendDiscordCommandRuntime({
      prisma: {
        discordGuildBinding: { findUnique: async () => null, upsert: async () => { throw new Error('no'); }, update: async () => { throw new Error('no'); } },
        musicBot: { findUnique: async () => null },
        tsServerConfig: { findUnique: async () => null },
      } as any,
      voiceBotManager: fakeManager(new Map()),
      instanceId: '   ',
      policy: policy(),
    });
    assert.equal(runtime, null);
    const app = express();
    installDiscordCommandRuntime(app, runtime);
    assert.equal(app.locals.discordCommandAdapter, undefined);
  });

  it('clearDiscordCommandRuntime drops locals without touching follow-up Memory stubs elsewhere', () => {
    const app = express();
    app.locals.discordCommandAdapter = { handle: async () => ({ ok: true }) };
    app.locals.discordInteractionFollowUp = new MemoryDiscordFollowUp();
    app.locals.discordGuildBindingLookup = { get: async () => null };
    clearDiscordCommandRuntime(app);
    assert.equal(app.locals.discordCommandAdapter, undefined);
    assert.equal(app.locals.discordInteractionFollowUp, undefined);
    assert.equal(app.locals.discordGuildBindingLookup, undefined);
  });
});
