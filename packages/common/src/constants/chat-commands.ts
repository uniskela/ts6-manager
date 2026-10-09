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
  'voteskip',
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

export const MEDIA_COMMAND_GROUPS = ['playback', 'queue', 'video'] as const;
export type MediaCommandGroup = (typeof MEDIA_COMMAND_GROUPS)[number];
export type MediaCommandAccess =
  | { mode: 'everyone' }
  | { mode: 'server_groups'; serverGroupIds: number[] };
export type MediaCommandPermissions = Record<MediaCommandGroup, MediaCommandAccess>;

/** Exhaustive so new built-ins must explicitly choose an authorization group. */
export const MEDIA_COMMAND_GROUP_BY_COMMAND = {
  help: 'info', commands: 'info', np: 'info', nowplaying: 'info',
  viewers: 'info', channels: 'info', lyrics: 'info',
  here: 'playback', come: 'playback', radio: 'playback', play: 'playback',
  stop: 'playback', pause: 'playback', skip: 'playback', next: 'playback',
  prev: 'playback', vol: 'playback', volume: 'playback', repeat: 'playback', seek: 'playback',
  queue: 'queue', add: 'queue', shuffle: 'queue', playlist: 'queue', pl: 'queue', remove: 'queue',
  stream: 'video', stopstream: 'video', tv: 'video', iptv: 'video',
  voteskip: 'listener',
} as const satisfies Record<BuiltinChatCommand, MediaCommandGroup | 'info' | 'listener'>;

/** Read-only command forms stay public even when controls are restricted. */
export function mediaCommandGroup(command: string, args = ''): MediaCommandGroup | 'info' | 'listener' | null {
  if (!Object.prototype.hasOwnProperty.call(MEDIA_COMMAND_GROUP_BY_COMMAND, command)) return null;
  const value = args.trim().toLowerCase();
  if (command === 'queue' && (!value || value === 'show')) return 'info';
  if (!value && ['vol', 'volume', 'playlist', 'pl', 'radio', 'repeat'].includes(command)) return 'info';
  return MEDIA_COMMAND_GROUP_BY_COMMAND[command as BuiltinChatCommand];
}
