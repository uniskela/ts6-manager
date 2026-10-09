import {
  BUILTIN_CHAT_COMMANDS,
  type BuiltinChatCommand,
} from '@ts6/common';

export { BUILTIN_CHAT_COMMANDS, type BuiltinChatCommand };

const BUILTIN_SET = new Set<string>(BUILTIN_CHAT_COMMANDS);

/** Short help lines for built-in commands (shown by !help). */
export const BUILTIN_COMMAND_HELP: { name: string; usage: string; blurb: string }[] = [
  { name: 'help', usage: '!help', blurb: 'Show this command list' },
  { name: 'commands', usage: '!commands', blurb: 'List enabled custom chat commands' },
  { name: 'here', usage: '!here [id]', blurb: 'Summon a music bot here (prefers idle bots; use !here <id> to target one)' },
  { name: 'come', usage: '!come [id]', blurb: 'Alias for !here' },
  {
    name: 'play',
    usage: '!play <url|song name>',
    blurb: 'Play a YouTube / Spotify / Apple Music link, or search YouTube Music by song name',
  },
  { name: 'queue', usage: '!queue [url|show|clear|remove <n>|play <n>]', blurb: 'Show queue or add a URL' },
  { name: 'add', usage: '!add <url>', blurb: 'Alias for !queue <url>' },
  { name: 'playlist', usage: '!playlist [name-or-id]', blurb: 'List or queue playlists for this server/bot' },
  { name: 'pl', usage: '!pl <name-or-id>', blurb: 'Alias for !playlist' },
  { name: 'repeat', usage: '!repeat [off|track|queue]', blurb: 'Show or set repeat mode' },
  { name: 'seek', usage: '!seek <seconds|+seconds|-seconds>', blurb: 'Seek within a local/downloaded track' },
  { name: 'remove', usage: '!remove <text>', blurb: 'Remove an unambiguous upcoming title/artist match' },
  { name: 'shuffle', usage: '!shuffle [on|off]', blurb: 'Toggle or set queue shuffle' },
  { name: 'stop', usage: '!stop', blurb: 'Stop playback and clear the queue' },
  { name: 'pause', usage: '!pause', blurb: 'Pause / resume' },
  { name: 'skip', usage: '!skip', blurb: 'Skip to next track' },
  { name: 'voteskip', usage: '!voteskip', blurb: 'Vote to skip: more than half of human listeners in the bot channel' },
  { name: 'next', usage: '!next', blurb: 'Alias for !skip' },
  { name: 'prev', usage: '!prev', blurb: 'Previous track' },
  { name: 'vol', usage: '!vol [0-100]', blurb: 'Show or set volume for music, radio, video, and IPTV' },
  { name: 'volume', usage: '!volume [0-100]', blurb: 'Alias for !vol' },
  { name: 'np', usage: '!np', blurb: 'Now playing' },
  { name: 'nowplaying', usage: '!nowplaying', blurb: 'Alias for !np' },
  { name: 'radio', usage: '!radio [id]', blurb: 'List or play radio stations' },
  { name: 'stream', usage: '!stream <url> [preset]', blurb: 'Start video stream (preset: auto, 480p–2160p)' },
  { name: 'stopstream', usage: '!stopstream', blurb: 'Stop video stream' },
  { name: 'viewers', usage: '!viewers', blurb: 'List stream viewers' },
  { name: 'channels', usage: '!channels [search]', blurb: 'List IPTV channels' },
  { name: 'tv', usage: '!tv <name>', blurb: 'Stream an IPTV channel' },
  { name: 'iptv', usage: '!iptv <name>', blurb: 'Alias for !tv' },
  { name: 'lyrics', usage: '!lyrics [artist - title]', blurb: 'Show lyrics for now playing or search' },
];

/**
 * Recommended server-scoped canned-reply templates.
 * Seeded via Music Bots → Commands (disabled until an admin edits and enables).
 */
export interface ChatCommandPreset {
  name: string;
  description: string;
  response: string;
}

export const CHAT_COMMAND_PRESETS: ChatCommandPreset[] = [
  {
    name: 'rules',
    description: 'Server rules',
    response: [
      '## Server rules',
      '',
      '1. Be respectful — no harassment or hate speech.',
      '2. No spam or excessive caps in chat/voice.',
      '3. Keep music requests reasonable; staff may skip tracks.',
      '4. Follow staff instructions.',
      '',
      '_Edit this text in Music Bots → Commands._',
    ].join('\n'),
  },
  {
    name: 'links',
    description: 'Useful community links',
    response: [
      '## Links',
      '',
      '- **Website:** https://example.com',
      '- **Discord:** https://discord.gg/your-invite',
      '- **Donate:** https://example.com/donate',
      '',
      '_Replace these URLs in Music Bots → Commands._',
    ].join('\n'),
  },
  {
    name: 'discord',
    description: 'Discord invite',
    response: [
      '## Discord',
      '',
      'Join us: https://discord.gg/your-invite',
      '',
      '_Or fold this into !links and disable !discord._',
    ].join('\n'),
  },
  {
    name: 'info',
    description: 'Short server / community blurb',
    response: [
      '## About',
      '',
      'Welcome to our TeamSpeak community. Music bots, radio, and chat commands keep the lobby moving.',
      '',
      'Type **!help** for music commands or **!commands** for custom replies.',
      '',
      '_Edit this blurb in Music Bots → Commands._',
    ].join('\n'),
  },
  {
    name: 'about',
    description: 'Alias-style community blurb (same idea as !info)',
    response: [
      '## About',
      '',
      'Welcome to our TeamSpeak community. Music bots, radio, and chat commands keep the lobby moving.',
      '',
      'Type **!help** for music commands or **!commands** for custom replies.',
      '',
      '_Edit this blurb in Music Bots → Commands._',
    ].join('\n'),
  },
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

/** Edit distance between two short command names (insert / delete / substitute / swap). */
function commandEditDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Closest built-in command to a mistyped name (e.g. `plya` → `play`), or null when nothing is close. */
export function suggestBuiltinCommand(raw: string): string | null {
  const name = raw.toLowerCase();
  if (name.length < 2 || name.length > 32) return null;
  const maxDistance = name.length <= 3 ? 1 : 2;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of BUILTIN_CHAT_COMMANDS) {
    const distance = commandEditDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= maxDistance ? best : null;
}
