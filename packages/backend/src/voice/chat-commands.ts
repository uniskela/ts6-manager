/**
 * Built-in music bot chat commands (without "!").
 * Keep in sync with MusicCommandHandler switch cases.
 */
export const BUILTIN_CHAT_COMMANDS = [
  'help',
  'radio',
  'play',
  'stop',
  'pause',
  'skip',
  'next',
  'prev',
  'vol',
  'volume',
  'np',
  'nowplaying',
  'queue',
  'add',
  'shuffle',
  'stream',
  'stopstream',
  'viewers',
  'channels',
  'tv',
  'iptv',
  'lyrics',
] as const;

export type BuiltinChatCommand = (typeof BUILTIN_CHAT_COMMANDS)[number];

const BUILTIN_SET = new Set<string>(BUILTIN_CHAT_COMMANDS);

/** Short help lines for built-in commands (shown by !help). */
export const BUILTIN_COMMAND_HELP: { name: string; usage: string; blurb: string }[] = [
  { name: 'help', usage: '!help', blurb: 'Show this command list' },
  {
    name: 'play',
    usage: '!play <url>',
    blurb: 'Play YouTube / Spotify / Apple Music (song or playlist)',
  },
  { name: 'queue', usage: '!queue [url|show|remove <n>]', blurb: 'Show queue or add a URL' },
  { name: 'add', usage: '!add <url>', blurb: 'Alias for !queue <url>' },
  { name: 'shuffle', usage: '!shuffle [on|off]', blurb: 'Toggle or set queue shuffle' },
  { name: 'stop', usage: '!stop', blurb: 'Stop playback and clear current track' },
  { name: 'pause', usage: '!pause', blurb: 'Pause / resume' },
  { name: 'skip', usage: '!skip', blurb: 'Skip to next track' },
  { name: 'next', usage: '!next', blurb: 'Alias for !skip' },
  { name: 'prev', usage: '!prev', blurb: 'Previous track' },
  { name: 'vol', usage: '!vol <0-100>', blurb: 'Set volume' },
  { name: 'volume', usage: '!volume <0-100>', blurb: 'Alias for !vol' },
  { name: 'np', usage: '!np', blurb: 'Now playing' },
  { name: 'nowplaying', usage: '!nowplaying', blurb: 'Alias for !np' },
  { name: 'radio', usage: '!radio [id]', blurb: 'List or play radio stations' },
  { name: 'stream', usage: '!stream <url>', blurb: 'Start video stream' },
  { name: 'stopstream', usage: '!stopstream', blurb: 'Stop video stream' },
  { name: 'viewers', usage: '!viewers', blurb: 'List stream viewers' },
  { name: 'channels', usage: '!channels [search]', blurb: 'List IPTV channels' },
  { name: 'tv', usage: '!tv <name>', blurb: 'Stream an IPTV channel' },
  { name: 'iptv', usage: '!iptv <name>', blurb: 'Alias for !tv' },
  { name: 'lyrics', usage: '!lyrics [artist - title]', blurb: 'Show lyrics for now playing or search' },
];

export function isReservedChatCommandName(name: string): boolean {
  return BUILTIN_SET.has(name.toLowerCase());
}

/** Normalize user input to a command name (no leading !). */
export function normalizeChatCommandName(raw: string): string {
  return raw
    .trim()
    .replace(/^!+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}
