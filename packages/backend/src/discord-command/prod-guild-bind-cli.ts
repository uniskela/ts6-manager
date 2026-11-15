/**
 * Production Discord guild-binding CLI (allowlisted existing DB only).
 *
 * Usage (from packages/backend):
 *   node --import tsx src/discord-command/prod-guild-bind-cli.ts preview-bind \
 *     --database-url file:/abs/path/data/ts6webui.db \
 *     --operator alice --application-id 123 --guild-id 456
 *
 * Writes require ALL of:
 *   --confirm-write
 *   --confirm-database-realpath <exact fs.realpath of that ts6webui.db>
 *   --audit-log <append-only jsonl path>
 *
 * Trust model: --operator is self-declared attribution, not authentication.
 * OS/container filesystem permissions on the confirmed DB path are the control
 * plane. There is no --allow-any-database.
 */
import { createRequire } from 'node:module';
import { applyProdGuildBinding, previewProdGuildBinding } from './prod-guild-bind.js';
import { assessProdGuildBindDatabaseUrl, formatProdDbTarget } from './prod-db-target.js';
import {
  appendProdGuildBindAudit,
  preflightProdGuildBindAuditLog,
} from './prod-guild-bind-audit.js';

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
  const confirmRealpath = argValue(argv, '--confirm-database-realpath');
  const auditLog = argValue(argv, '--audit-log');

  const target = assessProdGuildBindDatabaseUrl(databaseUrl, {
    requireExisting: true,
    confirmRealpath: confirmWrite ? confirmRealpath : undefined,
  });
  console.log(formatProdDbTarget(target));
  if (!target.ok) {
    console.error('Refusing: database target is not allowlisted / confirmed for production guild-bind.');
    if (target.realPath && !confirmRealpath) {
      console.error(`Hint: pass --confirm-database-realpath ${target.realPath}`);
    }
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
        confirmRealpath,
      });
      console.log(JSON.stringify(preview, null, 2));
      if (preview.databaseRealpath) {
        console.error(`Canonical database realpath: ${preview.databaseRealpath}`);
      }
      if (preview.errors.length) process.exit(1);
      if (action === 'bind' || action === 'revoke') {
        console.error('Dry-run only. Re-run with --confirm-write --confirm-database-realpath <realpath> --audit-log <path>.');
      }
      return;
    }

    if (!confirmRealpath?.trim()) {
      console.error('Writes require --confirm-database-realpath matching the printed realpath.');
      process.exit(2);
    }
    if (!auditLog?.trim()) {
      console.error('Writes require --audit-log <path> (append-only JSONL).');
      process.exit(2);
    }

    let auditPath: string;
    try {
      auditPath = preflightProdGuildBindAuditLog(auditLog);
    } catch (err) {
      console.error(`Audit preflight failed (no DB mutation): ${err instanceof Error ? err.message : err}`);
      process.exit(2);
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
      confirmRealpath,
    });
    console.log(JSON.stringify(result, null, 2));

    try {
      appendProdGuildBindAudit(auditPath, result.audit);
      console.log(`audit appended to ${auditPath}`);
    } catch (err) {
      // DB mutation already committed — fail loud so operators do not miss it.
      console.error('AUDIT_APPEND_FAILED after successful DB mutation.');
      console.error(err instanceof Error ? err.message : err);
      console.error('Printed audit record above; reconcile manually (revoke if needed).');
      console.error(JSON.stringify(result.audit));
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
