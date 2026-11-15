/**
 * Report Discord isolated-integration config readiness without printing secrets.
 *
 * Usage (from packages/backend):
 *   node --import tsx src/discord-command/integration-readiness-cli.ts
 *   node --import tsx src/discord-command/integration-readiness-cli.ts --env-file ../../.env.discord-integration-test
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { config } from '../config.js';
import {
  assessIntegrationReadiness,
  formatReadinessReport,
} from './integration-readiness.js';

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function main(): void {
  const argv = process.argv.slice(2);
  const envFile = argValue(argv, '--env-file');
  if (envFile) {
    loadDotenv({ path: path.resolve(process.cwd(), envFile), override: true });
  }

  // Re-read process.env after optional override (config module already loaded defaults).
  const roleIds = (name: string) => {
    const raw = (process.env[name] || '').trim();
    if (!raw) return [] as string[];
    return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  };

  const assessment = assessIntegrationReadiness({
    discordApplicationId: (process.env.DISCORD_APPLICATION_ID || config.discordApplicationId || '').trim(),
    discordPublicKeyHex: (process.env.DISCORD_PUBLIC_KEY || config.discordPublicKeyHex || '').trim(),
    discordBotToken: (process.env.DISCORD_BOT_TOKEN || config.discordBotToken || '').trim(),
    discordInstanceId: (process.env.DISCORD_INSTANCE_ID || config.discordInstanceId || '').trim(),
    discordViewerRoleIds: process.env.DISCORD_VIEWER_ROLE_IDS != null
      ? roleIds('DISCORD_VIEWER_ROLE_IDS')
      : config.discordViewerRoleIds,
    discordAdminRoleIds: process.env.DISCORD_ADMIN_ROLE_IDS != null
      ? roleIds('DISCORD_ADMIN_ROLE_IDS')
      : config.discordAdminRoleIds,
    discordInteractionsEnabled: process.env.DISCORD_INTERACTIONS_ENABLED != null
      ? process.env.DISCORD_INTERACTIONS_ENABLED === '1' || process.env.DISCORD_INTERACTIONS_ENABLED === 'true'
      : config.discordInteractionsEnabled,
    databaseUrl: (process.env.DATABASE_URL || config.databaseUrl || '').trim(),
    testGuildId: (process.env.DISCORD_TEST_GUILD_ID || '').trim() || undefined,
    testMusicBotId: (process.env.DISCORD_TEST_MUSIC_BOT_ID || '').trim() || undefined,
    testServerConfigId: (process.env.DISCORD_TEST_SERVER_CONFIG_ID || '').trim() || undefined,
  });

  console.log(formatReadinessReport(assessment));
  if (assessment.interactionsWouldEnable) {
    console.error('WARNING: DISCORD_INTERACTIONS_ENABLED is on — disable for preparation.');
    process.exitCode = 2;
    return;
  }
  process.exitCode = assessment.readyForSupervisedLive ? 0 : 1;
}

main();
