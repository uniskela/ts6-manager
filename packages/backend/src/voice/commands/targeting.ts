/**
 * Several music bots can sit in one channel, and each one hears every chat
 * line there. These helpers pick the single bot that answers a command:
 * the bot the user named, otherwise the one playing music, otherwise the
 * lowest bot id.
 */

export interface ChannelBot {
  id: number;
  /** Bot name and connect nickname; the live nickname follows now-playing titles. */
  names: string[];
  /** Playing or paused music, or streaming video. */
  active: boolean;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function findByName(bots: ChannelBot[], name: string): ChannelBot | undefined {
  const wanted = norm(name);
  if (!wanted) return undefined;
  return bots.find((b) => b.names.some((n) => norm(n) === wanted));
}

/** Commands without arguments, where a bare bot name (`!next Bot 2`) can only be a target. */
export const NO_ARG_COMMANDS: ReadonlySet<string> = new Set([
  'help', 'commands', 'stop', 'pause', 'skip', 'next', 'prev',
  'np', 'nowplaying', 'stopstream', 'viewers',
]);

/**
 * Split a bot name off command arguments: `!next Bot 2` (the whole argument
 * is a bot name, only for commands in NO_ARG_COMMANDS) or `!vol 30 @Bot 2`
 * (a trailing `@name`, for any command). Unknown names are left in the
 * arguments untouched, so `!playlist Test` still searches for "Test".
 */
export function parseBotTarget(
  command: string,
  args: string,
  bots: ChannelBot[],
): { botId: number | null; args: string } {
  if (NO_ARG_COMMANDS.has(command)) {
    const whole = findByName(bots, args);
    if (whole) return { botId: whole.id, args: '' };
  }

  const at = args.lastIndexOf('@');
  if (at >= 0 && (at === 0 || /\s/.test(args[at - 1]))) {
    const named = findByName(bots, args.slice(at + 1));
    if (named) return { botId: named.id, args: args.slice(0, at).trim() };
  }
  return { botId: null, args };
}

/** The bot that should answer, or null when there are no bots to choose from. */
export function chooseCommandBot(bots: ChannelBot[], targetId: number | null): number | null {
  if (bots.length === 0) return null;
  if (targetId != null && bots.some((b) => b.id === targetId)) return targetId;
  const byId = [...bots].sort((a, b) => a.id - b.id);
  return (byId.find((b) => b.active) ?? byId[0]).id;
}
