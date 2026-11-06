/**
 * Operator CLI for Discord guild ↔ music-bot bindings.
 * Default: dry-run preview. Writes require --confirm-write and an isolated DB URL.
 *
 * Usage (from packages/backend):
 *   node --import tsx src/discord-command/guild-bind-cli.ts status --guild-id 111...
 *   node --import tsx src/discord-command/guild-bind-cli.ts preview-bind \
 *     --guild-id 111... --instance-id discord-int-test --server-config-id 1 --music-bot-id 10
 *   node --import tsx src/discord-command/guild-bind-cli.ts bind ... --confirm-write
 *   node --import tsx src/discord-command/guild-bind-cli.ts revoke --guild-id 111... --confirm-write
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { config } from '../config.js';
import {
  applyGuildBinding,
  formatBindingPreview,
  previewGuildBinding,
} from './guild-bind.js';
import { openIsolatedPrisma } from './isolated-db.js';
import {
  assessIsolatedSqliteTarget,
  formatIsolatedDbTarget,
} from './isolated-db-target.js';

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function requireInt(name: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const envFile = argValue(argv, '--env-file');
  if (envFile) loadDotenv({ path: path.resolve(process.cwd(), envFile), override: true });

  const action = argv.find((a) => !a.startsWith('-') && !a.includes('/')) || 'status';
  const databaseUrl = (argValue(argv, '--database-url') || process.env.DATABASE_URL || config.databaseUrl).trim();
  const guildId = argValue(argv, '--guild-id');
  if (!guildId) {
    console.error('Required: --guild-id <snowflake>');
    process.exit(2);
  }

  const confirmWrite = argv.includes('--confirm-write');
  const allowAnyDatabase = argv.includes('--allow-any-database');
  const target = assessIsolatedSqliteTarget(databaseUrl, { allowAnyDatabase });
  console.log(formatIsolatedDbTarget(target));
  if (!target.ok) {
    console.error('Refusing to open database: target is not an approved disposable Discord integration DB.');
    process.exit(1);
  }

  const { prisma, disconnect } = await openIsolatedPrisma(databaseUrl);
  try {
    if (action === 'status' || action === 'preview-bind' || action === 'preview-revoke') {
      const preview = await previewGuildBinding(prisma, {
        action: action === 'preview-revoke' ? 'revoke' : action === 'status' ? 'status' : 'bind',
        databaseUrl,
        guildId,
        instanceId: argValue(argv, '--instance-id'),
        serverConfigId: argValue(argv, '--server-config-id')
          ? requireInt('--server-config-id', argValue(argv, '--server-config-id'))
          : undefined,
        musicBotId: argValue(argv, '--music-bot-id')
          ? requireInt('--music-bot-id', argValue(argv, '--music-bot-id'))
          : undefined,
      });
      console.log(formatBindingPreview(preview));
      process.exitCode = preview.errors.length ? 1 : 0;
      return;
    }

    if (action === 'bind') {
      const input = {
        guildId,
        instanceId: argValue(argv, '--instance-id') || process.env.DISCORD_INSTANCE_ID || config.discordInstanceId,
        serverConfigId: requireInt('--server-config-id', argValue(argv, '--server-config-id')),
        musicBotId: requireInt('--music-bot-id', argValue(argv, '--music-bot-id')),
      };
      if (!confirmWrite) {
        const preview = await previewGuildBinding(prisma, {
          action: 'bind',
          databaseUrl,
          ...input,
        });
        console.log(formatBindingPreview(preview));
        console.error('Dry-run only. Re-run with --confirm-write to bind.');
        process.exitCode = preview.errors.length ? 1 : 0;
        return;
      }
      const result = await applyGuildBinding(prisma, {
        action: 'bind',
        databaseUrl,
        confirmWrite: true,
        allowAnyDatabase,
        input,
      });
      console.log(`bound guildId=${result.row.guildId} bot=${result.row.musicBotId} revoked=${result.row.revoked}`);
      return;
    }

    if (action === 'revoke') {
      if (!confirmWrite) {
        const preview = await previewGuildBinding(prisma, {
          action: 'revoke',
          databaseUrl,
          guildId,
        });
        console.log(formatBindingPreview(preview));
        console.error('Dry-run only. Re-run with --confirm-write to revoke.');
        process.exitCode = preview.errors.length ? 1 : 0;
        return;
      }
      const result = await applyGuildBinding(prisma, {
        action: 'revoke',
        databaseUrl,
        confirmWrite: true,
        allowAnyDatabase,
        guildId,
      });
      console.log(`revoked guildId=${result.row.guildId} revoked=${result.row.revoked}`);
      return;
    }

    console.error(`Unknown action: ${action}`);
    process.exit(2);
  } finally {
    await disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
