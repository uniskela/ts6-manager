/**
 * Built-in music bot chat commands (without "!").
 * Keep in sync with MusicCommandHandler switch cases.
 */
export const BUILTIN_CHAT_COMMANDS = [
  'help',
  'commands',
  'here',
  'come',
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
  'playlist',
  'pl',
  'repeat',
  'seek',
  'remove',
  'stream',
  'stopstream',
  'viewers',
  'channels',
  'tv',
  'iptv',
  'lyrics',
] as const;

export type BuiltinChatCommand = (typeof BUILTIN_CHAT_COMMANDS)[number];
