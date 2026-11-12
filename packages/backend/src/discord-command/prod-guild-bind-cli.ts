/**
 * Production Discord guild-binding CLI (disposable or allowlisted prod DB only).
 *
 * Usage (from packages/backend):
 *   node --import tsx src/discord-command/prod-guild-bind-cli.ts status \
 *     --database-url file:./data/ts6webui.db \
 *     --operator alice --application-id 123 --guild-id 456
 *   ... preview-bind / bind / revoke with the same identity flags
 *
 * Mutations require --confirm-write. There is no --allow-any-database.
 */
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { applyProdGuildBinding, previewProdGuildBinding } from './prod-guild-bind.js';
import { assessProdGuildBindDatabaseUrl, formatProdDbTarget } from './prod-db-target.js';

const require = createRequire(import.meta.url);

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function requireArg(argv: string[], name: string): string {
  const v = argValue(argv, name);
  if (!v) throw new Error(`Missing required ${name}`);
  return v;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const action = argv[0];
  if (!action || ['status', 'preview-bind', 'bind', 'revoke'].indexOf(action) < 0) {
    console.error('Usage: prod-guild-bind-cli.ts <status|preview-bind|bind|revoke> ...');
    process.exit(2);
  }

  const databaseUrl = argValue(argv, '--database-url') || process.env.DATABASE_URL || '';
  const operator = requireArg(argv, '--operator');
  const applicationId = requireArg(argv, '--application-id');
  const guildId = requireArg(argv, '--guild-id');
  const confirmWrite = argv.includes('--confirm-write');
  const auditLog = argValue(argv, '--audit-log');

  const target = assessProdGuildBindDatabaseUrl(databaseUrl);
  console.log(formatProdDbTarget(target));
  if (!target.ok) {
    console.error('Refusing: database target is not allowlisted for production guild-bind.');
    process.exit(2);
  }

  const { PrismaClient } = require('../../generated/prisma/index.js') as typeof import('../../generated/prisma/index.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    if (action === 'status' || action === 'preview-bind' || (action === 'bind' && !confirmWrite) || (action === 'revoke' && !confirmWrite)) {
      const preview = await previewProdGuildBinding(prisma as any, {
        action: action === 'preview-bind' || action === 'bind' ? 'bind' : action === 'revoke' ? 'revoke' : 'status',
        databaseUrl,
        operator,
        applicationId,
        guildId,
        instanceId: argValue(argv, '--instance-id'),
        serverConfigId: argValue(argv, '--server-config-id') ? Number(argValue(argv, '--server-config-id')) : undefined,
        musicBotId: argValue(argv, '--music-bot-id') ? Number(argValue(argv, '--music-bot-id')) : undefined,
      });
      console.log(JSON.stringify(preview, null, 2));
      if (preview.errors.length) process.exit(1);
      if (action === 'bind' || action === 'revoke') {
        console.error('Dry-run only. Re-run with --confirm-write to apply.');
      }
      return;
    }

    const result = await applyProdGuildBinding(prisma as any, {
      action: action === 'bind' ? 'bind' : 'revoke',
      databaseUrl,
      operator,
      applicationId,
      guildId,
      instanceId: argValue(argv, '--instance-id'),
      serverConfigId: argValue(argv, '--server-config-id') ? Number(argValue(argv, '--server-config-id')) : undefined,
      musicBotId: argValue(argv, '--music-bot-id') ? Number(argValue(argv, '--music-bot-id')) : undefined,
      confirmWrite: true,
    });
    console.log(JSON.stringify(result, null, 2));
    if (auditLog) {
      appendFileSync(auditLog, `${JSON.stringify(result.audit)}\n`, { mode: 0o600 });
      console.log(`audit appended to ${auditLog}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
