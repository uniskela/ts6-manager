/**
 * Bootstrap an isolated SQLite DB for Discord integration testing.
 * Uses prisma db push + playlist nameKey finalisation + minimal fixtures.
 * Never targets a URL lacking the discord-int-test marker unless explicitly allowed.
 */
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { finalizePlaylistNameKeyMigration } from '../voice/commands/playlist-name.js';
import { assessIsolatedSqliteTarget } from './isolated-db-target.js';

const require = createRequire(import.meta.url);
const prismaCli = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

export type IsolatedDbFixtureIds = {
  serverConfigId: number;
  musicBotId: number;
  serverName: string;
  botName: string;
  instanceId: string;
};

export const DEFAULT_ISOLATED_FIXTURES: IsolatedDbFixtureIds = {
  serverConfigId: 1,
  musicBotId: 10,
  serverName: 'Discord Int Test TS',
  botName: 'Discord Int Test Bot',
  instanceId: 'discord-int-test',
};

export function assertIsolatedDatabaseUrl(databaseUrl: string, allowAny = false): string {
  const assessment = assessIsolatedSqliteTarget(databaseUrl, { allowAnyDatabase: allowAny });
  if (!assessment.ok) {
    throw new Error(
      assessment.errors[0]
      ?? 'DATABASE_URL must resolve to basename discord-int-test.db (production basenames refused)',
    );
  }
  return assessment.databaseUrl;
}

/** file:./path/db.sqlite → ensure parent dir exists */
export async function ensureSqliteParentDir(databaseUrl: string): Promise<void> {
  const m = /^file:(.+?)(\?|$)/.exec(databaseUrl.trim());
  if (!m) return;
  let filePath = m[1];
  if (filePath.startsWith('./') || filePath.startsWith('../') || !path.isAbsolute(filePath)) {
    filePath = path.resolve(process.cwd(), filePath);
  } else if (filePath.startsWith('/')) {
    // absolute ok
  }
  await mkdir(path.dirname(filePath), { recursive: true });
}

export function pushIsolatedSchema(databaseUrl: string): void {
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

export async function openIsolatedPrisma(databaseUrl: string): Promise<{
  prisma: any;
  disconnect: () => Promise<void>;
}> {
  const { PrismaClient } = require('../../generated/prisma/index.js') as typeof import('../../generated/prisma/index.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  return {
    prisma,
    disconnect: async () => {
      await prisma.$disconnect();
    },
  };
}

/** Alias for operator CLIs. */
export const openIsolatedPrismaPath = openIsolatedPrisma;

export async function seedIsolatedFixtures(
  prisma: any,
  fixtures: IsolatedDbFixtureIds = DEFAULT_ISOLATED_FIXTURES,
): Promise<IsolatedDbFixtureIds> {
  await prisma.tsServerConfig.upsert({
    where: { id: fixtures.serverConfigId },
    create: {
      id: fixtures.serverConfigId,
      name: fixtures.serverName,
      host: '127.0.0.1',
      apiKey: 'discord-int-test-placeholder',
    },
    update: { name: fixtures.serverName },
  });
  await prisma.musicBot.upsert({
    where: { id: fixtures.musicBotId },
    create: {
      id: fixtures.musicBotId,
      serverConfigId: fixtures.serverConfigId,
      name: fixtures.botName,
      virtualServerId: 1,
    },
    update: {
      serverConfigId: fixtures.serverConfigId,
      name: fixtures.botName,
    },
  });
  return fixtures;
}

export async function bootstrapIsolatedDiscordDb(opts: {
  databaseUrl: string;
  allowAnyDatabase?: boolean;
  fixtures?: IsolatedDbFixtureIds;
}): Promise<{
  databaseUrl: string;
  fixtures: IsolatedDbFixtureIds;
  nameKeyBackfilled: number;
  hasDiscordGuildBindingTable: boolean;
}> {
  const databaseUrl = assertIsolatedDatabaseUrl(opts.databaseUrl, opts.allowAnyDatabase === true);
  await ensureSqliteParentDir(databaseUrl);
  pushIsolatedSchema(databaseUrl);

  const { prisma, disconnect } = await openIsolatedPrisma(databaseUrl);
  try {
    const fixtures = await seedIsolatedFixtures(prisma, opts.fixtures);
    const { backfilled } = await finalizePlaylistNameKeyMigration(prisma);
    const rawTables: unknown = await (prisma as { $queryRawUnsafe: (q: string) => Promise<unknown> })
      .$queryRawUnsafe(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='DiscordGuildBinding'`,
      );
    const tables = Array.isArray(rawTables) ? rawTables as Array<{ name: string }> : [];
    return {
      databaseUrl,
      fixtures,
      nameKeyBackfilled: backfilled,
      hasDiscordGuildBindingTable: tables.length === 1,
    };
  } finally {
    await disconnect();
  }
}
