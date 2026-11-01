/** Phase 2 command names. Adapter rejects these until playback wiring lands. */
export const MUSIC_COMMANDS = [
  'play', 'pause', 'resume', 'skip', 'stop', 'queue', 'nowplaying', 'playlist', 'radio',
] as const;

export type MusicCommand = (typeof MUSIC_COMMANDS)[number];

export function isMusicCommand(command: string): command is MusicCommand {
  return (MUSIC_COMMANDS as readonly string[]).includes(command);
}

/** Reserved so Phase 2 can call MusicCommandHandler without a second queue. */
export type MusicCommandRequest = {
  command: MusicCommand;
  args: Record<string, string>;
  guildId: string;
  userId: string;
};

export function assertMusicNotImplemented(_request: MusicCommandRequest): never {
  throw new Error('Phase 2 music commands are not implemented');
}
