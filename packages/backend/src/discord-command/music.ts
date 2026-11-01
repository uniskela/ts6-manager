export const PHASE_2A_MUSIC_COMMANDS = ['play', 'queue', 'nowplaying'] as const;
export const PHASE_2B_MUSIC_COMMANDS = ['pause', 'resume', 'skip', 'stop', 'playlist', 'radio', 'volume'] as const;

/** Phase 2 command names. 2B stays rejected until those handlers land. */
export const MUSIC_COMMANDS = [...PHASE_2A_MUSIC_COMMANDS, ...PHASE_2B_MUSIC_COMMANDS] as const;

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
