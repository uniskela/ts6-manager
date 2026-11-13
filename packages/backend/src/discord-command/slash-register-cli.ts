/**
 * Guild slash-command registration CLI (preview by default; explicit apply).
 *
 * Working directory in published images: /app/packages/backend
 *
 * Preview (no Discord writes):
 *   node dist/discord-command/slash-register-cli.js preview \
 *     --application-id <id> --guild-id <id>
 *   node dist/discord-command/slash-register-cli.js preview \
 *     --application-id <id> --guild-id <id> --fetch-remote
 *
 * Apply (POST upserts by name only; never global / bulk PUT / DELETE):
 *   DISCORD_BOT_TOKEN=… node dist/discord-command/slash-register-cli.js apply \
 *     --application-id <id> --guild-id <id> \
 *     --names play,queue,ts \
 *     --confirm-apply \
 *     [--confirm-same-name-overwrite]
 *
 * Token is read only from DISCORD_BOT_TOKEN (env). Never pass tokens as argv.
 * docker compose exec does not forward host env — use `exec -e DISCORD_BOT_TOKEN=…`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import type { DiscordHttpTransport } from './discord-delivery.js';
import { getSupportedSlashCommands } from './slash-commands.js';
import {
  createSlashRegistrationClient,
  previewSlashRegistration,
  type RemoteGuildCommand,
  type SlashRegistrationApplyResult,
} from './slash-registration.js';

export type SlashRegisterCliDeps = {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Injected HTTP transport (tests). Production omit → real fetch. */
  transport?: DiscordHttpTransport;
  readRemoteFile?: (path: string) => RemoteGuildCommand[];
  /** Test-only: shrink Discord 429 honour window. */
  rateLimitWaitBudgetMs?: number;
};

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function parseNames(raw: string | undefined): string[] {
  if (raw == null) return [];
  return [...new Set(raw.split(',').map((n) => n.trim()).filter(Boolean))];
}

function botAuthorization(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.DISCORD_BOT_TOKEN || config.discordBotToken || '').trim();
  if (!raw) return null;
  return raw.startsWith('Bot ') ? raw : `Bot ${raw}`;
}

function formatApplyResult(result: SlashRegistrationApplyResult): string {
  const lines = [
    `Discord slash registration APPLY`,
    `applicationId=${result.applicationId} guildId=${result.guildId}`,
    `created=${result.applied.filter((a) => a.action === 'create').map((a) => a.name).join(',') || '(none)'}`,
    `updated=${result.applied.filter((a) => a.action === 'update').map((a) => a.name).join(',') || '(none)'}`,
    `unchangedOrSkipped=${result.skipped.join(',') || '(none)'}`,
    `errors=${result.errors.map((e) => `${e.name}:${e.message}`).join(',') || '(none)'}`,
  ];
  if (result.applied.length && result.errors.length) {
    lines.push('PARTIAL: some commands were written; remaining errors must be resolved before retrying failed names.');
  } else if (result.errors.length) {
    lines.push('FAILED: no successful writes in this summary (or only errors); see errors above.');
  } else if (!result.applied.length) {
    lines.push('OK: nothing to write (requested names already match or were skipped).');
  } else {
    lines.push('OK: requested writes completed without reported errors.');
  }
  return lines.join('\n');
}

function usage(error: (line: string) => void): void {
  error('Usage:');
  error('  slash-register-cli.js preview --application-id <id> --guild-id <id> [--fetch-remote|--remote <file>] [--names a,b]');
  error('  slash-register-cli.js apply --application-id <id> --guild-id <id> --names a,b --confirm-apply [--confirm-same-name-overwrite]');
  error('DISCORD_BOT_TOKEN is required for --fetch-remote and apply (env only; never argv).');
}

/**
 * CLI entry for tests and production. Returns process exit code.
 */
export async function runSlashRegisterCli(
  argv: string[],
  deps: SlashRegisterCliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;

  const actionArg = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'preview';
  const rest = actionArg === argv[0] ? argv.slice(1) : argv;
  if (actionArg !== 'preview' && actionArg !== 'apply') {
    error(`Unknown action: ${actionArg}`);
    usage(error);
    return 2;
  }

  const applicationId = argValue(rest, '--application-id') || config.discordApplicationId;
  const guildId = argValue(rest, '--guild-id');
  if (!applicationId || !guildId) {
    error('Required: --application-id <snowflake> --guild-id <snowflake>');
    return 2;
  }

  const namesRaw = argValue(rest, '--names');
  const names = parseNames(namesRaw);
  const supported = new Set(getSupportedSlashCommands().map((c) => c.name));

  if (actionArg === 'apply') {
    if (!rest.includes('--confirm-apply')) {
      error('Apply refused: pass --confirm-apply (preview is the default).');
      return 2;
    }
    if (namesRaw == null) {
      error('Apply refused: --names <comma-separated> is required (never implied as all commands).');
      return 2;
    }
    if (names.length === 0) {
      error('Apply refused: --names must list at least one command.');
      return 2;
    }
    const unknown = names.filter((n) => !supported.has(n));
    if (unknown.length) {
      error(`Apply refused: unknown or unsupported command names: ${unknown.join(',')}`);
      error(`Supported: ${[...supported].join(',')}`);
      return 2;
    }

    const authorization = botAuthorization(env);
    if (!authorization) {
      error('DISCORD_BOT_TOKEN required for apply (set in the process environment; not as a CLI flag).');
      return 2;
    }

    const client = createSlashRegistrationClient({
      applicationId,
      authorization,
      transport: deps.transport,
      rateLimitWaitBudgetMs: deps.rateLimitWaitBudgetMs,
    });

    try {
      // Live re-fetch inside apply() — do not pass a frozen --remote snapshot.
      const result = await client.apply(guildId, {
        names,
        confirmApply: true,
        confirmSameNameOverwrite: rest.includes('--confirm-same-name-overwrite') ? true : undefined,
      });
      log(formatApplyResult(result));
      if (result.errors.length) return 1;
      return 0;
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  // --- preview (default) ---
  const remotePath = argValue(rest, '--remote');
  let remote: RemoteGuildCommand[] | undefined;
  if (remotePath) {
    const reader = deps.readRemoteFile ?? ((p: string) => JSON.parse(readFileSync(p, 'utf8')) as RemoteGuildCommand[]);
    remote = reader(remotePath);
  }

  if (rest.includes('--fetch-remote')) {
    const authorization = botAuthorization(env);
    if (!authorization) {
      error('DISCORD_BOT_TOKEN required for --fetch-remote');
      return 2;
    }
    const client = createSlashRegistrationClient({
      applicationId,
      authorization,
      transport: deps.transport,
      rateLimitWaitBudgetMs: deps.rateLimitWaitBudgetMs,
    });
    try {
      const plan = await client.dryRun(guildId);
      log(client.formatPlan(plan));
      if (names.length) {
        const subset = {
          create: plan.create.filter((c) => names.includes(c.name)).map((c) => c.name),
          update: plan.update.filter((u) => names.includes(u.local.name)).map((u) => u.local.name),
          unchanged: plan.unchanged.filter((u) => names.includes(u.local.name)).map((u) => u.local.name),
          collisions: plan.collisions.filter((c) => names.includes(c.remote.name)).map((c) => c.remote.name),
        };
        log('--- subset filter --names ---');
        log(`wanted=${names.join(',')}`);
        log(`create=${subset.create.join(',') || '(none)'}`);
        log(`update=${subset.update.join(',') || '(none)'}`);
        log(`unchanged=${subset.unchanged.join(',') || '(none)'}`);
        log(`collisions=${subset.collisions.join(',') || '(none)'}`);
      }
      if (plan.validationErrors.length) {
        error('Validation errors:');
        for (const err of plan.validationErrors) error(`- ${err}`);
        return 1;
      }
      return 0;
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  const { text, plan } = previewSlashRegistration({ applicationId, guildId, remote });
  log(text);

  if (names.length) {
    const subset = {
      create: plan.create.filter((c) => names.includes(c.name)).map((c) => c.name),
      update: plan.update.filter((u) => names.includes(u.local.name)).map((u) => u.local.name),
      unchanged: plan.unchanged.filter((u) => names.includes(u.local.name)).map((u) => u.local.name),
      collisions: plan.collisions.filter((c) => names.includes(c.remote.name)).map((c) => c.remote.name),
    };
    log('--- subset filter --names ---');
    log(`wanted=${names.join(',')}`);
    log(`create=${subset.create.join(',') || '(none)'}`);
    log(`update=${subset.update.join(',') || '(none)'}`);
    log(`unchanged=${subset.unchanged.join(',') || '(none)'}`);
    log(`collisions=${subset.collisions.join(',') || '(none)'}`);
    log('NOTE: preview only; apply requires action=apply, --names, and --confirm-apply.');
  }

  if (plan.validationErrors.length) {
    error('Validation errors:');
    for (const err of plan.validationErrors) error(`- ${err}`);
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  const code = await runSlashRegisterCli(process.argv.slice(2));
  process.exit(code);
}

// Run only when executed as a script (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
