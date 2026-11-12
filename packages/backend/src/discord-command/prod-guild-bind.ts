/**
 * Production guild-binding preview/bind/revoke.
 * Uses explicit prod DB allowlist — never isolated --allow-any-database.
 *
 * Trust model: `--operator` / operator string is self-declared attribution for
 * the audit trail. It does not authenticate. Authorisation is whoever can run
 * this CLI with filesystem write access to the confirmed database realpath
 * (container volume mount / host permissions). Prefer running only as the
 * service admin that already owns the data volume.
 */
import {
  assertDiscordGuildId,
  createDiscordGuildBindingService,
  type DiscordGuildBindingRow,
  toGuildBindingRow,
} from './guild-bindings.js';
import {
  assessProdGuildBindDatabaseUrl,
  formatProdDbTarget,
} from './prod-db-target.js';
import type { BindingPrisma } from './guild-bind.js';

function assertSnowflake(label: string, value: string): string {
  const v = value.trim();
  if (!/^\d{17,20}$/.test(v)) {
    throw new Error(`${label} must be a Discord snowflake`);
  }
  return v;
}

export type ProdBindingPreview = {
  dryRun: true;
  action: 'bind' | 'revoke' | 'status';
  operator: string;
  applicationId: string;
  guildId: string;
  databaseTarget: string;
  databaseUrlSafe: boolean;
  databaseRealpath: string | null;
  instanceId?: string;
  serverConfigId?: number;
  musicBotId?: number;
  serverExists: boolean;
  botExists: boolean;
  botOnServer: boolean;
  existing: DiscordGuildBindingRow | null;
  errors: string[];
};

export type ProdBindingWriteResult = {
  dryRun: false;
  action: 'bind' | 'revoke';
  operator: string;
  applicationId: string;
  guildId: string;
  databaseRealpath: string;
  row: DiscordGuildBindingRow;
  audit: Record<string, unknown>;
};

async function loadExisting(
  prisma: BindingPrisma,
  guildId: string,
): Promise<DiscordGuildBindingRow | null> {
  const row = await prisma.discordGuildBinding.findUnique({ where: { guildId } });
  return row ? toGuildBindingRow(row) : null;
}

export async function previewProdGuildBinding(
  prisma: BindingPrisma,
  opts: {
    action: 'bind' | 'revoke' | 'status';
    databaseUrl: string;
    operator: string;
    applicationId: string;
    guildId: string;
    instanceId?: string;
    serverConfigId?: number;
    musicBotId?: number;
    /** Optional; when set, preview also validates the confirm path. */
    confirmRealpath?: string;
  },
): Promise<ProdBindingPreview> {
  const guildId = assertDiscordGuildId(opts.guildId);
  const applicationId = assertSnowflake('applicationId', opts.applicationId);
  const operator = opts.operator.trim();
  const errors: string[] = [];
  if (!operator) errors.push('operator identity is required');

  const dbTarget = assessProdGuildBindDatabaseUrl(opts.databaseUrl, {
    requireExisting: true,
    confirmRealpath: opts.confirmRealpath,
  });
  const databaseUrlSafe = dbTarget.ok;
  if (!databaseUrlSafe) {
    errors.push(`unsafe DATABASE_URL: ${dbTarget.errors[0] ?? 'invalid target'}`);
  }

  let serverExists = false;
  let botExists = false;
  let botOnServer = false;

  if (opts.action === 'bind') {
    if (!opts.instanceId?.trim()) errors.push('instanceId is required for bind');
    if (opts.serverConfigId == null) errors.push('serverConfigId is required for bind');
    if (opts.musicBotId == null) errors.push('musicBotId is required for bind');
  }

  if (opts.serverConfigId != null) {
    const server = await prisma.tsServerConfig.findUnique({ where: { id: opts.serverConfigId } });
    serverExists = !!server;
    if (!server) errors.push(`serverConfigId ${opts.serverConfigId} not found`);
  }
  if (opts.musicBotId != null) {
    const bot = await prisma.musicBot.findUnique({ where: { id: opts.musicBotId } });
    botExists = !!bot;
    if (!bot) errors.push(`musicBotId ${opts.musicBotId} not found`);
    else if (opts.serverConfigId != null) {
      botOnServer = bot.serverConfigId === opts.serverConfigId;
      if (!botOnServer) {
        errors.push(`musicBot ${opts.musicBotId} is not on serverConfig ${opts.serverConfigId}`);
      }
    }
  }

  const existing = await loadExisting(prisma, guildId);
  if (opts.action === 'revoke' && !existing) {
    errors.push(`no binding for guild ${guildId}`);
  }

  return {
    dryRun: true,
    action: opts.action,
    operator,
    applicationId,
    guildId,
    databaseTarget: formatProdDbTarget(dbTarget),
    databaseUrlSafe,
    databaseRealpath: dbTarget.realPath,
    instanceId: opts.instanceId,
    serverConfigId: opts.serverConfigId,
    musicBotId: opts.musicBotId,
    serverExists,
    botExists,
    botOnServer,
    existing,
    errors,
  };
}

export async function applyProdGuildBinding(
  prisma: BindingPrisma,
  opts: {
    action: 'bind' | 'revoke';
    databaseUrl: string;
    operator: string;
    applicationId: string;
    guildId: string;
    instanceId?: string;
    serverConfigId?: number;
    musicBotId?: number;
    confirmWrite: true;
    /** Exact fs.realpath of the intended database (required for writes). */
    confirmRealpath: string;
  },
): Promise<ProdBindingWriteResult> {
  if (opts.confirmWrite !== true) {
    throw new Error('applyProdGuildBinding requires confirmWrite: true');
  }
  if (!opts.confirmRealpath?.trim()) {
    throw new Error('applyProdGuildBinding requires confirmRealpath (canonical database path)');
  }

  const writeTarget = assessProdGuildBindDatabaseUrl(opts.databaseUrl, {
    requireExisting: true,
    confirmRealpath: opts.confirmRealpath,
  });
  if (!writeTarget.ok || !writeTarget.realPath) {
    throw new Error(
      `Refusing write: ${writeTarget.errors[0] ?? 'unsafe DATABASE_URL'} `
      + `(resolved=${writeTarget.resolvedPath ?? 'n/a'}). `
      + 'Production guild-bind requires existing ts6webui.db + matching --confirm-database-realpath; '
      + 'there is no --allow-any-database bypass.',
    );
  }

  const preview = await previewProdGuildBinding(prisma, {
    ...opts,
    confirmRealpath: opts.confirmRealpath,
  });
  if (preview.errors.length) {
    throw new Error(`Refusing write: ${preview.errors.join('; ')}`);
  }

  const svc = createDiscordGuildBindingService(prisma as any);
  let row: DiscordGuildBindingRow;
  if (opts.action === 'bind') {
    row = await svc.bind({
      guildId: preview.guildId,
      instanceId: opts.instanceId!.trim(),
      serverConfigId: opts.serverConfigId!,
      musicBotId: opts.musicBotId!,
    });
  } else {
    row = await svc.revoke(preview.guildId);
  }

  const audit = {
    at: new Date().toISOString(),
    operator: preview.operator,
    applicationId: preview.applicationId,
    action: opts.action,
    guildId: preview.guildId,
    musicBotId: row.musicBotId,
    serverConfigId: row.serverConfigId,
    instanceId: row.instanceId,
    revoked: row.revoked,
    databaseRealpath: writeTarget.realPath,
  };

  return {
    dryRun: false,
    action: opts.action,
    operator: preview.operator,
    applicationId: preview.applicationId,
    guildId: preview.guildId,
    databaseRealpath: writeTarget.realPath,
    row,
    audit,
  };
}
