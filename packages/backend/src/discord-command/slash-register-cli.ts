/**
 * Offline / operator preview for guild slash-command registration.
 *
 * Usage (from packages/backend):
 *   node --import tsx src/discord-command/slash-register-cli.ts \
 *     --application-id 123 --guild-id 456
 *
 * Optional: --remote path/to/remote-commands.json (array of Discord command objects)
 *
 * Always dry-run. Does not call Discord unless --fetch-remote is passed with
 * DISCORD_BOT_TOKEN set (still prints plan only; no apply in this CLI).
 */
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { createSlashRegistrationClient, previewSlashRegistration } from './slash-registration.js';
import type { RemoteGuildCommand } from './slash-registration.js';

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const applicationId = argValue(argv, '--application-id') || config.discordApplicationId;
  const guildId = argValue(argv, '--guild-id');
  if (!applicationId || !guildId) {
    console.error('Required: --application-id <snowflake> --guild-id <snowflake>');
    process.exit(2);
  }

  const remotePath = argValue(argv, '--remote');
  let remote: RemoteGuildCommand[] | undefined;
  if (remotePath) {
    remote = JSON.parse(readFileSync(remotePath, 'utf8')) as RemoteGuildCommand[];
  }

  if (argv.includes('--fetch-remote')) {
    const token = config.discordBotToken;
    if (!token) {
      console.error('DISCORD_BOT_TOKEN required for --fetch-remote');
      process.exit(2);
    }
    const client = createSlashRegistrationClient({
      applicationId,
      authorization: token.startsWith('Bot ') ? token : `Bot ${token}`,
    });
    const plan = await client.dryRun(guildId);
    console.log(client.formatPlan(plan));
    return;
  }

  const { text, plan } = previewSlashRegistration({ applicationId, guildId, remote });
  console.log(text);
  if (plan.validationErrors.length) {
    console.error('Validation errors:');
    for (const err of plan.validationErrors) console.error(`- ${err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
