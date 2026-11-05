import type { GuildBinding } from './adapter.js';
import type { GuildBindingLookup } from './runtime.js';
import { AppError } from '../middleware/error-handler.js';

/** Discord snowflake: digits only, keep as string (never Number()). */
export function assertDiscordGuildId(guildId: string): string {
  // Digits only; keep as string (never Number()). Length allows fixtures and real snowflakes.
  if (typeof guildId !== 'string' || !/^[0-9]{1,32}$/.test(guildId)) {
    throw new AppError(400, 'guildId must be a Discord snowflake string.');
  }
  return guildId;
}

export type DiscordGuildBindingRow = {
  guildId: string;
  instanceId: string;
  serverConfigId: number;
  musicBotId: number;
  revoked: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type GuildBindingWriteInput = {
  guildId: string;
  instanceId: string;
  serverConfigId: number;
  musicBotId: number;
};

type BindingDb = {
  discordGuildBinding: {
    findUnique(args: any): Promise<any>;
    upsert(args: any): Promise<any>;
    update(args: any): Promise<any>;
    findMany?(args: any): Promise<any[]>;
  };
  musicBot: {
    findUnique(args: any): Promise<{ id: number; serverConfigId: number } | null>;
  };
  tsServerConfig: {
    findUnique(args: any): Promise<{ id: number } | null>;
  };
  $transaction?<T>(fn: (tx: BindingDb) => Promise<T>): Promise<T>;
};

function mapActive(row: {
  instanceId: string;
  revoked: boolean;
  musicBotId: number;
  serverConfigId: number;
  musicBot?: { id: number; serverConfigId: number } | null;
}): GuildBinding | null {
  if (row.revoked) {
    return {
      instanceId: row.instanceId,
      revoked: true,
      botId: row.musicBotId,
      serverConfigId: row.serverConfigId,
    };
  }
  // Fail closed: missing bot or cross-server drift → treat as unpaired.
  if (!row.musicBot) return null;
  if (row.musicBot.serverConfigId !== row.serverConfigId) return null;
  return {
    instanceId: row.instanceId,
    revoked: false,
    botId: row.musicBotId,
    serverConfigId: row.serverConfigId,
  };
}

/**
 * Prisma-backed guild binding lookup. No in-process cache — each get() hits the DB
 * so revocation is visible immediately (multi-instance: last writer wins on upsert).
 */
export function createPrismaGuildBindingLookup(db: BindingDb): GuildBindingLookup {
  return {
    async get(guildId: string): Promise<GuildBinding | null> {
      if (typeof guildId !== 'string' || guildId.length === 0) return null;
      try {
        // Avoid required-relation include (Prisma throws on orphan FK). Resolve bot/server separately.
        const row = await db.discordGuildBinding.findUnique({ where: { guildId } });
        if (!row) return null;
        if (row.revoked) {
          return {
            instanceId: row.instanceId,
            revoked: true,
            botId: row.musicBotId,
            serverConfigId: row.serverConfigId,
          };
        }
        const server = await db.tsServerConfig.findUnique({
          where: { id: row.serverConfigId },
          select: { id: true },
        });
        if (!server) return null;
        const musicBot = await db.musicBot.findUnique({
          where: { id: row.musicBotId },
          select: { id: true, serverConfigId: true },
        });
        return mapActive({ ...row, musicBot });
      } catch (err) {
        // Propagate so the adapter maps to unavailable (not unpaired/null).
        // Callers must not treat I/O failures as "guild not bound".
        throw err;
      }
    },
  };
}

export type DiscordGuildBindingService = {
  /** Create or reassign an active binding after verifying bot∈server. */
  bind(input: GuildBindingWriteInput): Promise<DiscordGuildBindingRow>;
  /** Revoke in place; subsequent get() returns revoked (adapter → unpaired). */
  revoke(guildId: string): Promise<DiscordGuildBindingRow>;
  lookup: GuildBindingLookup;
};

async function assertBotOnServer(
  db: BindingDb,
  serverConfigId: number,
  musicBotId: number,
): Promise<void> {
  if (!Number.isInteger(serverConfigId) || serverConfigId <= 0) {
    throw new AppError(400, 'serverConfigId must be a positive whole number.');
  }
  if (!Number.isInteger(musicBotId) || musicBotId <= 0) {
    throw new AppError(400, 'musicBotId must be a positive whole number.');
  }
  const server = await db.tsServerConfig.findUnique({
    where: { id: serverConfigId },
    select: { id: true },
  });
  if (!server) throw new AppError(400, `Server ${serverConfigId} does not exist.`);
  const bot = await db.musicBot.findUnique({
    where: { id: musicBotId },
    select: { id: true, serverConfigId: true },
  });
  if (!bot) throw new AppError(400, `Music bot ${musicBotId} does not exist.`);
  if (bot.serverConfigId !== serverConfigId) {
    throw new AppError(400, 'Music bot does not belong to the authorised TeamSpeak server.');
  }
}

function toRow(row: any): DiscordGuildBindingRow {
  return {
    guildId: row.guildId,
    instanceId: row.instanceId,
    serverConfigId: row.serverConfigId,
    musicBotId: row.musicBotId,
    revoked: row.revoked,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Internal admin/service API for binding management.
 * Not exposed as a Discord command — guilds cannot self-bind.
 */
export function createDiscordGuildBindingService(db: BindingDb): DiscordGuildBindingService {
  const lookup = createPrismaGuildBindingLookup(db);

  async function bind(input: GuildBindingWriteInput): Promise<DiscordGuildBindingRow> {
    const guildId = assertDiscordGuildId(input.guildId);
    const instanceId = typeof input.instanceId === 'string' ? input.instanceId.trim() : '';
    if (!instanceId || instanceId.length > 128) {
      throw new AppError(400, 'instanceId is required.');
    }
    await assertBotOnServer(db, input.serverConfigId, input.musicBotId);

    const run = async (tx: BindingDb) => {
      const row = await tx.discordGuildBinding.upsert({
        where: { guildId },
        create: {
          guildId,
          instanceId,
          serverConfigId: input.serverConfigId,
          musicBotId: input.musicBotId,
          revoked: false,
        },
        update: {
          instanceId,
          serverConfigId: input.serverConfigId,
          musicBotId: input.musicBotId,
          revoked: false,
        },
      });
      return toRow(row);
    };

    if (db.$transaction) return db.$transaction(run);
    return run(db);
  }

  async function revoke(guildId: string): Promise<DiscordGuildBindingRow> {
    const id = assertDiscordGuildId(guildId);
    try {
      const row = await db.discordGuildBinding.update({
        where: { guildId: id },
        data: { revoked: true },
      });
      return toRow(row);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'P2025') throw new AppError(404, 'Guild binding not found.');
      throw err;
    }
  }

  return { bind, revoke, lookup };
}
