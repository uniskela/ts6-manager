/**
 * Stage B path-filter proxy (do not start without approval).
 *
 * Usage (from packages/backend):
 *   node --import tsx src/discord-int-path-filter-cli.ts \
 *     --upstream http://127.0.0.1:3011 --listen-port 3012
 *
 * Exposes only POST /api/discord/interactions on 127.0.0.1:<listen-port>.
 * Point a temporary HTTPS tunnel at this filter — never at the backend directly.
 */
import {
  DISCORD_INTERACTIONS_PATH,
  listenDiscordInteractionsPathFilter,
} from './discord-int-path-filter.js';

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const upstream = (argValue(argv, '--upstream') || 'http://127.0.0.1:3011').trim();
  const listenHost = (argValue(argv, '--listen-host') || '127.0.0.1').trim();
  const listenPort = Number(argValue(argv, '--listen-port') || '3012');
  if (!Number.isInteger(listenPort) || listenPort <= 0) {
    console.error('Invalid --listen-port');
    process.exit(2);
  }

  const { url } = await listenDiscordInteractionsPathFilter({
    upstreamOrigin: upstream,
    listenHost,
    listenPort,
  });
  console.log(`[discord-int-path-filter] listening on ${url}`);
  console.log(`[discord-int-path-filter] allowing only POST ${DISCORD_INTERACTIONS_PATH}`);
  console.log(`[discord-int-path-filter] upstream ${upstream}`);
  console.log('[discord-int-path-filter] tunnel should target this filter, not the backend');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
