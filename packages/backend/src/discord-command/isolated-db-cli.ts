/**
 * Bootstrap an isolated Discord integration SQLite database.
 * Default is dry-run (identify target only). Writes require --confirm-write.
 *
 * Usage (from packages/backend):
 *   node --import tsx src/discord-command/isolated-db-cli.ts \
 *     --database-url 'file:./data/discord-int-test.db'
 *   node --import tsx src/discord-command/isolated-db-cli.ts \
 *     --database-url 'file:./data/discord-int-test.db' --confirm-write
 */
import {
  assessIsolatedSqliteTarget,
  formatIsolatedDbTarget,
} from './isolated-db-target.js';
import { bootstrapIsolatedDiscordDb, DEFAULT_ISOLATED_FIXTURES } from './isolated-db.js';

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const databaseUrl = (argValue(argv, '--database-url') || process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    console.error('Required: --database-url file:./data/discord-int-test.db');
    process.exit(2);
  }

  const allowAnyDatabase = argv.includes('--allow-any-database');
  const confirmWrite = argv.includes('--confirm-write');
  const assessment = assessIsolatedSqliteTarget(databaseUrl, { allowAnyDatabase });

  console.log('Isolated DB bootstrap target:');
  console.log(formatIsolatedDbTarget(assessment));

  if (!assessment.ok) {
    console.error('Refusing bootstrap: unsafe or non-disposable DATABASE_URL.');
    process.exit(1);
  }

  if (!confirmWrite) {
    console.log('DRY RUN — no database writes. Re-run with --confirm-write to bootstrap.');
    return;
  }

  const result = await bootstrapIsolatedDiscordDb({
    databaseUrl,
    allowAnyDatabase,
    fixtures: DEFAULT_ISOLATED_FIXTURES,
  });
  console.log([
    'Isolated Discord integration DB ready (write confirmed)',
    `resolvedPath=${assessment.resolvedPath}`,
    `DiscordGuildBinding=${result.hasDiscordGuildBindingTable}`,
    `nameKeyBackfilled=${result.nameKeyBackfilled}`,
    `serverConfigId=${result.fixtures.serverConfigId}`,
    `musicBotId=${result.fixtures.musicBotId}`,
    `instanceId=${result.fixtures.instanceId}`,
  ].join('\n'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
