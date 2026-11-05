/**
 * Operator guild-binding preview/bind/status/revoke.
 * Defaults to dry-run; mutations require explicit confirm + isolated DB marker.
 */
import {
  assertDiscordGuildId,
  createDiscordGuildBindingService,
  type DiscordGuildBindingRow,
  type GuildBindingWriteInput,
} from './guild-bindings.js';
import {
  assessIsolatedSqliteTarget,
  formatIsolatedDbTarget,
} from './isolated-db-target.js';

export type BindingPrisma = {
  discordGuildBinding: {
    findUnique(args: any): Promise<any>;
    upsert(args: any): Promise<any>;
    update(args: any): Promise<any>;
  };
  musicBot: {
    findUnique(args: any): Promise<{ id: number; serverConfigId: number; name?: string } | null>;
  };
  tsServerConfig: {
    findUnique(args: any): Promise<{ id: number; name?: string } | null>;
  };
  $transaction?<T>(fn: (tx: BindingPrisma) => Promise<T>): Promise<T>;
};

export type BindingPreview = {
  dryRun: true;
  action: 'bind' | 'revoke' | 'status';
  databaseUrlSafe: boolean;
  databaseTarget: string;
  guildId: string;
  instanceId?: string;
  serverConfigId?: number;
  musicBotId?: number;
  serverExists: boolean;
  botExists: boolean;
  botOnServer: boolean;
  existing: DiscordGuildBindingRow | null;
  lookup: Awaited<ReturnType<ReturnType<typeof createDiscordGuildBindingService>['lookup']['get']>>;
  errors: string[];
};

export type BindingWriteResult = {
  dryRun: false;
  action: 'bind' | 'revoke';
  row: DiscordGuildBindingRow;
};

function requireIsolatedDb(databaseUrl: string, allowAnyDatabase: boolean): void {
  const assessment = assessIsolatedSqliteTarget(databaseUrl, { allowAnyDatabase });
  if (!assessment.ok) {
    throw new Error(
      `Refusing write: ${assessment.errors[0] ?? 'unsafe DATABASE_URL'} `
      + `(resolved=${assessment.resolvedPath ?? 'n/a'}). `
      + 'Basename must be discord-int-test.db unless --allow-any-database; production basenames are always refused.',
    );
  }
}

async function loadExisting(
  prisma: BindingPrisma,
  guildId: string,
): Promise<DiscordGuildBindingRow | null> {
  const row = await prisma.discordGuildBinding.findUnique({ where: { guildId } });
  if (!row) return null;
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

export async function previewGuildBinding(
  prisma: BindingPrisma,
  opts: {
    action: 'bind' | 'revoke' | 'status';
    databaseUrl: string;
    guildId: string;
    instanceId?: string;
    serverConfigId?: number;
    musicBotId?: number;
  },
): Promise<BindingPreview> {
  const guildId = assertDiscordGuildId(opts.guildId);
  const errors: string[] = [];
  const dbTarget = assessIsolatedSqliteTarget(opts.databaseUrl);
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
    const server = await prisma.tsServerConfig.findUnique({
      where: { id: opts.serverConfigId },
      select: { id: true },
    });
    serverExists = !!server;
    if (!server) errors.push(`serverConfigId ${opts.serverConfigId} not found`);
  }

  if (opts.musicBotId != null) {
    const bot = await prisma.musicBot.findUnique({
      where: { id: opts.musicBotId },
      select: { id: true, serverConfigId: true },
    });
    botExists = !!bot;
    if (!bot) {
      errors.push(`musicBotId ${opts.musicBotId} not found`);
    } else if (opts.serverConfigId != null) {
      botOnServer = bot.serverConfigId === opts.serverConfigId;
      if (!botOnServer) errors.push('music bot does not belong to serverConfigId');
    }
  }

  const existing = await loadExisting(prisma, guildId);
  const svc = createDiscordGuildBindingService(prisma as any);
  const lookup = await svc.lookup.get(guildId);

  if (opts.action === 'revoke' && !existing) {
    errors.push('no binding row to revoke');
  }

  return {
    dryRun: true,
    action: opts.action,
    databaseUrlSafe,
    databaseTarget: formatIsolatedDbTarget(dbTarget),
    guildId,
    instanceId: opts.instanceId,
    serverConfigId: opts.serverConfigId,
    musicBotId: opts.musicBotId,
    serverExists,
    botExists,
    botOnServer,
    existing,
    lookup,
    errors,
  };
}

export function formatBindingPreview(preview: BindingPreview): string {
  const lines = [
    `Guild binding DRY RUN action=${preview.action}`,
    `guildId=${preview.guildId}`,
    `databaseUrlSafe=${preview.databaseUrlSafe}`,
    preview.databaseTarget,
    `instanceId=${preview.instanceId ?? '(n/a)'}`,
    `serverConfigId=${preview.serverConfigId ?? '(n/a)'} serverExists=${preview.serverExists}`,
    `musicBotId=${preview.musicBotId ?? '(n/a)'} botExists=${preview.botExists} botOnServer=${preview.botOnServer}`,
    `existing=${preview.existing
      ? `instance=${preview.existing.instanceId} bot=${preview.existing.musicBotId} server=${preview.existing.serverConfigId} revoked=${preview.existing.revoked}`
      : '(none)'}`,
    `lookup=${preview.lookup
      ? `instance=${preview.lookup.instanceId} bot=${preview.lookup.botId ?? 'null'} revoked=${preview.lookup.revoked}`
      : '(unpaired/null)'}`,
    `errors=${preview.errors.length ? preview.errors.join('; ') : '(none)'}`,
    'NOTE: pass --confirm-write to mutate; default is dry-run (no writes).',
  ];
  return lines.join('\n');
}

export async function applyGuildBinding(
  prisma: BindingPrisma,
  opts: {
    action: 'bind' | 'revoke';
    databaseUrl: string;
    confirmWrite: true;
    allowAnyDatabase?: boolean;
    input?: GuildBindingWriteInput;
    guildId?: string;
  },
): Promise<BindingWriteResult> {
  if (opts.confirmWrite !== true) {
    throw new Error('applyGuildBinding requires confirmWrite: true');
  }
  requireIsolatedDb(opts.databaseUrl, opts.allowAnyDatabase === true);

  const preview = await previewGuildBinding(prisma, {
    action: opts.action,
    databaseUrl: opts.databaseUrl,
    guildId: opts.action === 'bind' ? opts.input!.guildId : opts.guildId!,
    instanceId: opts.input?.instanceId,
    serverConfigId: opts.input?.serverConfigId,
    musicBotId: opts.input?.musicBotId,
  });
  if (preview.errors.length) {
    throw new Error(`Binding refused: ${preview.errors[0]}`);
  }

  const svc = createDiscordGuildBindingService(prisma as any);
  if (opts.action === 'bind') {
    const row = await svc.bind(opts.input!);
    return { dryRun: false, action: 'bind', row };
  }
  const row = await svc.revoke(opts.guildId!);
  return { dryRun: false, action: 'revoke', row };
}
