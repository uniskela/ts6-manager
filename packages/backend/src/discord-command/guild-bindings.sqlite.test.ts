import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { createDiscordCommandAdapter } from './adapter.js';
import {
  assertDiscordGuildId,
  createDiscordGuildBindingService,
  createPrismaGuildBindingLookup,
} from './guild-bindings.js';
import { createDiscordCommandRuntime, MemoryGuildBindingLookup } from './runtime.js';
import { defaultMediaCommandPermissions } from '../voice/media-command-permissions.js';
import { MemoryCommandIdempotency } from './idempotency.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../../generated/prisma/index.js') as typeof import('../../generated/prisma/index.js');
const prismaCli = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

const GUILD_A = '111000000000000001';
const GUILD_B = '222000000000000002';

async function openDb() {
  const root = await mkdtemp(path.join(tmpdir(), 'ts6-guild-bind-'));
  const url = `file:${path.join(root, 'test.db')}?connection_limit=1`;
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.tsServerConfig.create({ data: { id: 1, name: 'One', host: 'one.test', apiKey: 'x' } });
  await prisma.tsServerConfig.create({ data: { id: 2, name: 'Two', host: 'two.test', apiKey: 'x' } });
  await prisma.musicBot.create({ data: { id: 10, serverConfigId: 1, name: 'Bot1' } });
  await prisma.musicBot.create({ data: { id: 20, serverConfigId: 2, name: 'Bot2' } });
  return { root, prisma, url };
}

describe('persistent Discord guild bindings (Phase 2C step 2)', () => {
  it('keeps guild IDs as exact digit strings', () => {
    assert.equal(assertDiscordGuildId(GUILD_A), GUILD_A);
    assert.equal(assertDiscordGuildId('999'), '999');
    assert.throws(() => assertDiscordGuildId('abc'), /snowflake/);
    assert.throws(() => assertDiscordGuildId(`${GUILD_A}.0`), /snowflake/);
    assert.throws(() => assertDiscordGuildId(''), /snowflake/);
  });

  it('1–2. authorised binding persists and survives reconnect', async () => {
    const { root, prisma, url } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      const saved = await svc.bind({
        guildId: GUILD_A,
        instanceId: 'inst-1',
        serverConfigId: 1,
        musicBotId: 10,
      });
      assert.equal(saved.guildId, GUILD_A);
      assert.equal(saved.revoked, false);
      assert.equal(saved.musicBotId, 10);

      const first = await svc.lookup.get(GUILD_A);
      assert.deepEqual(first, {
        instanceId: 'inst-1',
        revoked: false,
        botId: 10,
        serverConfigId: 1,
      });

      await prisma.$disconnect();
      const prisma2 = new PrismaClient({ datasources: { db: { url } } });
      const lookup2 = createPrismaGuildBindingLookup(prisma2 as any);
      const again = await lookup2.get(GUILD_A);
      assert.deepEqual(again, first);
      await prisma2.$disconnect();
    } finally {
      await prisma.$disconnect().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('3–5. unknown, revoked, and disabled (revoked) guilds are denied', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      assert.equal(await svc.lookup.get(GUILD_B), null);

      await svc.bind({
        guildId: GUILD_A,
        instanceId: 'inst-1',
        serverConfigId: 1,
        musicBotId: 10,
      });
      await svc.revoke(GUILD_A);
      const revoked = await svc.lookup.get(GUILD_A);
      assert.equal(revoked?.revoked, true);

      const adapter = createDiscordCommandAdapter({
        bindings: svc.lookup,
        policy: { viewerRoleIds: ['r'], adminRoleIds: ['a'] },
        presence: { async snapshot() { return null; } },
        bridge: { async health() { return null; } },
        audit: () => {},
      });
      const unknown = await adapter.handle({
        guildId: GUILD_B,
        userId: 'u',
        roleIds: ['r'],
        memberPermissions: '0',
        command: 'ts.help',
      });
      assert.equal(unknown.code, 'unpaired');
      const denied = await adapter.handle({
        guildId: GUILD_A,
        userId: 'u',
        roleIds: ['r'],
        memberPermissions: '0',
        command: 'ts.help',
      });
      assert.equal(denied.code, 'unpaired');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('6. guild cannot bind another server\'s music bot', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await assert.rejects(
        () => svc.bind({
          guildId: GUILD_A,
          instanceId: 'inst-1',
          serverConfigId: 1,
          musicBotId: 20, // belongs to server 2
        }),
        /does not belong/i,
      );
      assert.equal(await svc.lookup.get(GUILD_A), null);
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('7. missing/deleted bot, deleted server, and bot moved to another server fail closed', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      const lookup = createPrismaGuildBindingLookup(prisma as any);

      await svc.bind({
        guildId: GUILD_A,
        instanceId: 'inst-1',
        serverConfigId: 1,
        musicBotId: 10,
      });

      // Orphan musicBotId
      await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = OFF`);
      await prisma.$executeRawUnsafe(
        `UPDATE "DiscordGuildBinding" SET "musicBotId" = 999 WHERE "guildId" = ?`,
        GUILD_A,
      );
      await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = ON`);
      assert.equal(await lookup.get(GUILD_A), null);

      // Restore valid bind, then move bot to another server (drift)
      await svc.bind({
        guildId: GUILD_A,
        instanceId: 'inst-1',
        serverConfigId: 1,
        musicBotId: 10,
      });
      await prisma.musicBot.update({ where: { id: 10 }, data: { serverConfigId: 2 } });
      assert.equal(await lookup.get(GUILD_A), null, 'bot reassigned to another server must not authorise');

      // Bind again with consistent pair, then delete server (CASCADE removes binding)
      await prisma.musicBot.update({ where: { id: 10 }, data: { serverConfigId: 1 } });
      await svc.bind({
        guildId: GUILD_A,
        instanceId: 'inst-1',
        serverConfigId: 1,
        musicBotId: 10,
      });
      await prisma.tsServerConfig.delete({ where: { id: 1 } });
      assert.equal(await lookup.get(GUILD_A), null, 'deleted server must not leave an authorised binding');

      // Orphan serverConfigId on remaining guild
      await prisma.tsServerConfig.create({ data: { id: 1, name: 'One', host: 'one.test', apiKey: 'x' } });
      await prisma.musicBot.create({ data: { id: 10, serverConfigId: 1, name: 'Bot1' } });
      await svc.bind({
        guildId: GUILD_B,
        instanceId: 'inst-1',
        serverConfigId: 1,
        musicBotId: 10,
      });
      await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = OFF`);
      await prisma.$executeRawUnsafe(
        `UPDATE "DiscordGuildBinding" SET "serverConfigId" = 999 WHERE "guildId" = ?`,
        GUILD_B,
      );
      await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = ON`);
      assert.equal(await lookup.get(GUILD_B), null);

      await assert.rejects(
        () => svc.bind({
          guildId: '333000000000000003',
          instanceId: 'inst-1',
          serverConfigId: 1,
          musicBotId: 404,
        }),
        /does not exist/i,
      );
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rebind after revoke restores access only via the binding service', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({
        guildId: GUILD_A,
        instanceId: 'inst-1',
        serverConfigId: 1,
        musicBotId: 10,
      });
      await svc.revoke(GUILD_A);
      assert.equal((await svc.lookup.get(GUILD_A))?.revoked, true);

      const restored = await svc.bind({
        guildId: GUILD_A,
        instanceId: 'inst-1',
        serverConfigId: 1,
        musicBotId: 10,
      });
      assert.equal(restored.revoked, false);
      assert.deepEqual(await svc.lookup.get(GUILD_A), {
        instanceId: 'inst-1',
        revoked: false,
        botId: 10,
        serverConfigId: 1,
      });
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Discord command adapter/music surface cannot call bind or revoke', async () => {
    const discord = await import('./index.js');
    assert.equal(typeof discord.createDiscordGuildBindingService, 'function');
    assert.equal(typeof (discord as any).bind, 'undefined');
    assert.equal(typeof (discord as any).revoke, 'undefined');
    // Adapter handle path only receives GuildBindingLookup.get — no write API.
    const svc = {
      bind: async () => { throw new Error('bind must not run'); },
      revoke: async () => { throw new Error('revoke must not run'); },
      lookup: { async get() { return { instanceId: 'i', revoked: false, botId: 10, serverConfigId: 1 }; } },
    };
    const adapter = createDiscordCommandAdapter({
      bindings: svc.lookup,
      policy: { viewerRoleIds: ['r'], adminRoleIds: ['a'] },
      presence: { async snapshot() { return { connected: true, serverName: 'x', nicknames: [], channels: [] }; } },
      bridge: { async health() { return null; } },
      audit: () => {},
    });
    const result = await adapter.handle({
      guildId: GUILD_A,
      userId: 'u',
      roleIds: ['r'],
      memberPermissions: '0',
      command: 'ts.help',
    });
    assert.equal(result.ok, true);
  });

  it('9–10. concurrent updates and reassignment keep one active binding', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await prisma.musicBot.create({ data: { id: 11, serverConfigId: 1, name: 'Bot1b' } });

      const results = await Promise.all([
        svc.bind({ guildId: GUILD_A, instanceId: 'inst-1', serverConfigId: 1, musicBotId: 10 }),
        svc.bind({ guildId: GUILD_A, instanceId: 'inst-1', serverConfigId: 1, musicBotId: 11 }),
      ]);
      assert.equal(results.length, 2);
      const count = await prisma.discordGuildBinding.count({ where: { guildId: GUILD_A } });
      assert.equal(count, 1);
      const active = await svc.lookup.get(GUILD_A);
      assert.ok(active && !active.revoked);
      assert.ok(active!.botId === 10 || active!.botId === 11);

      const reassigned = await svc.bind({
        guildId: GUILD_A,
        instanceId: 'inst-2',
        serverConfigId: 2,
        musicBotId: 20,
      });
      assert.equal(reassigned.musicBotId, 20);
      assert.equal(reassigned.serverConfigId, 2);
      assert.equal(reassigned.revoked, false);
      assert.deepEqual(await svc.lookup.get(GUILD_A), {
        instanceId: 'inst-2',
        revoked: false,
        botId: 20,
        serverConfigId: 2,
      });
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('11. revoked binding is not usable after revoke', async () => {
    const { root, prisma } = await openDb();
    try {
      const svc = createDiscordGuildBindingService(prisma as any);
      await svc.bind({
        guildId: GUILD_A,
        instanceId: 'inst-1',
        serverConfigId: 1,
        musicBotId: 10,
      });
      await svc.revoke(GUILD_A);
      const runtime = createDiscordCommandRuntime({
        bindings: svc.lookup,
        policy: { viewerRoleIds: ['r'], adminRoleIds: ['a'] },
        music: {
          getBot: () => ({ currentConfig: { id: 10, serverConfigId: 1, volume: 1 } } as any),
          virtualServerIdForBot: () => 1,
          loadMediaPermissions: async () => defaultMediaCommandPermissions(),
          idempotency: new MemoryCommandIdempotency(),
        },
      });
      const result = await runtime.adapter.handle({
        guildId: GUILD_A,
        userId: 'u',
        roleIds: ['r'],
        memberPermissions: '0',
        command: 'nowplaying',
      });
      assert.equal(result.code, 'unpaired');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('12. database unavailable produces a safe adapter failure', async () => {
    const adapter = createDiscordCommandAdapter({
      bindings: {
        async get() {
          throw new Error('SQLITE_ERROR: disk I/O');
        },
      },
      policy: { viewerRoleIds: ['r'], adminRoleIds: ['a'] },
      presence: { async snapshot() { return null; } },
      bridge: { async health() { return null; } },
      audit: () => {},
    });
    const result = await adapter.handle({
      guildId: GUILD_A,
      userId: 'u',
      roleIds: ['r'],
      memberPermissions: '0',
      command: 'ts.help',
    });
    assert.equal(result.code, 'unavailable');
    assert.doesNotMatch(result.content, /SQLITE|disk I\/O/i);
  });

  it('does not auto-install MemoryGuildBindingLookup as production default', async () => {
    const mem = new MemoryGuildBindingLookup();
    assert.equal(await mem.get('1'), null);
    // Runtime requires an explicit bindings object — no silent Memory fallback.
    const runtime = createDiscordCommandRuntime({
      bindings: createPrismaGuildBindingLookup({
        discordGuildBinding: {
          findUnique: async () => null,
          upsert: async () => { throw new Error('no'); },
          update: async () => { throw new Error('no'); },
        },
        musicBot: { findUnique: async () => null },
        tsServerConfig: { findUnique: async () => null },
      }),
      policy: { viewerRoleIds: [], adminRoleIds: [] },
      music: {
        getBot: () => null,
        virtualServerIdForBot: () => 1,
        loadMediaPermissions: async () => defaultMediaCommandPermissions(),
      },
    });
    assert.ok(runtime.bindings);
    assert.equal(runtime.bindings instanceof MemoryGuildBindingLookup, false);
  });

  it('fresh schema push creates DiscordGuildBinding without touching playlists', async () => {
    const { root, prisma } = await openDb();
    try {
      await prisma.playlist.create({
        data: { name: 'Keep', nameKey: 'keep', mode: 'stream', serverConfigId: 1 },
      });
      const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='DiscordGuildBinding'`,
      );
      assert.equal(tables.length, 1);
      const playlists = await prisma.playlist.findMany();
      assert.equal(playlists.length, 1);
      assert.equal(playlists[0].name, 'Keep');
    } finally {
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  });
});
