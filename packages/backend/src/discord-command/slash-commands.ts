import { MUSIC_COMMANDS, isMusicCommand } from './music.js';
import { planAcknowledgement } from './interaction.js';

/** Discord Application Command type: CHAT_INPUT */
export const DISCORD_CHAT_INPUT = 1;

/** Option types used by this registry (Discord ApplicationCommandOptionType). */
export const DiscordOptionType = {
  SUB_COMMAND: 1,
  STRING: 3,
} as const;

const NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;
const DESC_MAX = 100;
const OPTIONS_MAX = 25;

export type SlashOptionDefinition = {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  options?: SlashOptionDefinition[];
};

/**
 * Discord REST application-command definition for **guild** registration.
 * Scope comes from POST …/guilds/{guildId}/commands — not from global-only
 * fields (`dm_permission`, `contexts`, `integration_types`).
 */
export type SlashCommandDefinition = {
  type: typeof DISCORD_CHAT_INPUT;
  name: string;
  description: string;
  /**
   * Discord UI default only — backend still enforces guild binding, TS6 roles,
   * and media permissions. null = visible to everyone in the guild UI (does not
   * grant backend admin).
   */
  default_member_permissions: string | null;
  options?: SlashOptionDefinition[];
  /** Adapter command names this definition routes to (for handler coverage checks). */
  handlerCommands: readonly string[];
  /** TS6 policy hint for docs/tests — not sent to Discord. */
  ts6Permission: 'viewer' | 'admin' | 'viewer+media';
};

function opt(
  type: number,
  name: string,
  description: string,
  extra: Partial<SlashOptionDefinition> = {},
): SlashOptionDefinition {
  return { type, name, description, ...extra };
}

function sub(
  name: string,
  description: string,
  options?: SlashOptionDefinition[],
): SlashOptionDefinition {
  return opt(DiscordOptionType.SUB_COMMAND, name, description, options ? { options } : {});
}

/**
 * Authoritative slash-command registry derived from the Discord adapter + music service.
 * Do not add names here without a matching adapter/music handler.
 */
export function getSupportedSlashCommands(): SlashCommandDefinition[] {
  return [
    {
      type: DISCORD_CHAT_INPUT,
      name: 'ts',
      description: 'TeamSpeak presence and bridge status',
      default_member_permissions: null,
      ts6Permission: 'viewer',
      handlerCommands: ['ts.help', 'ts.status', 'ts.online', 'ts.channels', 'ts.bridge'],
      options: [
        sub('help', 'List available TS6 Discord commands'),
        sub('status', 'TeamSpeak connection status (admin)'),
        sub('online', 'Connected TeamSpeak nicknames'),
        sub('channels', 'TeamSpeak channel names'),
        sub('bridge', 'Bridge and audio health (admin)'),
      ],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'play',
      description: 'Queue a URL or search for a song',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['play'],
      options: [
        opt(DiscordOptionType.STRING, 'query', 'URL or song search query', { required: true }),
      ],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'queue',
      description: 'Show the music queue',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['queue'],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'nowplaying',
      description: 'Show what is playing now',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['nowplaying'],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'pause',
      description: 'Pause playback',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['pause'],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'resume',
      description: 'Resume playback',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['resume'],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'skip',
      description: 'Skip the current track',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['skip'],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'stop',
      description: 'Stop playback and clear the queue head',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['stop'],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'volume',
      description: 'Show or set playback volume (0-100)',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['volume'],
      options: [
        // STRING: interaction parser only copies string option values into intent.args.
        opt(DiscordOptionType.STRING, 'level', 'Volume 0-100 (omit to show current)', { required: false }),
      ],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'playlist',
      description: 'List, play, or edit server playlists',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['playlist'],
      options: [
        sub('list', 'List playlists'),
        sub('tracks', 'List tracks and removable positions in a playlist', [
          opt(DiscordOptionType.STRING, 'name', 'Playlist name', { required: true }),
        ]),
        sub('play', 'Enqueue a saved playlist', [
          opt(DiscordOptionType.STRING, 'name', 'Playlist name', { required: true }),
        ]),
        sub('create', 'Create a playlist (admin)', [
          opt(DiscordOptionType.STRING, 'name', 'New playlist name', { required: true }),
        ]),
        sub('add', 'Add a URL to a playlist (admin)', [
          opt(DiscordOptionType.STRING, 'name', 'Playlist name', { required: true }),
          opt(DiscordOptionType.STRING, 'url', 'Track URL', { required: true }),
        ]),
        sub('remove', 'Remove a track by #N or title (admin)', [
          opt(DiscordOptionType.STRING, 'name', 'Playlist name', { required: true }),
          opt(DiscordOptionType.STRING, 'track', 'Position (#N) or title', { required: true }),
        ]),
      ],
    },
    {
      type: DISCORD_CHAT_INPUT,
      name: 'radio',
      description: 'List or play radio stations',
      default_member_permissions: null,
      ts6Permission: 'viewer+media',
      handlerCommands: ['radio'],
      options: [
        sub('list', 'List radio stations'),
        sub('play', 'Play a radio station', [
          opt(DiscordOptionType.STRING, 'station', 'Station name or id', { required: true }),
        ]),
      ],
    },
  ];
}

/** Adapter command names that must have handlers (ts.* + music). */
export function getSupportedHandlerCommands(): readonly string[] {
  const fromSlash = getSupportedSlashCommands().flatMap((c) => [...c.handlerCommands]);
  return [...new Set(fromSlash)];
}

export function validateSlashCommandDefinition(cmd: SlashCommandDefinition): string[] {
  const errors: string[] = [];
  if (cmd.type !== DISCORD_CHAT_INPUT) errors.push(`${cmd.name}: type must be CHAT_INPUT (1)`);
  if (!NAME_RE.test(cmd.name) || cmd.name !== cmd.name.toLowerCase()) {
    errors.push(`${cmd.name}: invalid command name`);
  }
  if (!cmd.description || cmd.description.length > DESC_MAX) {
    errors.push(`${cmd.name}: description must be 1-${DESC_MAX} chars`);
  }
  // Guild commands omit deprecated dm_permission (global-only); do not emit contexts.
  if (cmd.options && cmd.options.length > OPTIONS_MAX) {
    errors.push(`${cmd.name}: more than ${OPTIONS_MAX} options`);
  }
  for (const option of cmd.options ?? []) {
    errors.push(...validateOption(cmd.name, option, 1));
  }
  if (!cmd.handlerCommands.length) errors.push(`${cmd.name}: missing handlerCommands`);
  for (const handler of cmd.handlerCommands) {
    if (handler.startsWith('ts.')) continue;
    if (!isMusicCommand(handler)) errors.push(`${cmd.name}: unknown handler ${handler}`);
  }
  return errors;
}

function validateOption(path: string, option: SlashOptionDefinition, depth: number): string[] {
  const errors: string[] = [];
  const here = `${path}.${option.name}`;
  if (depth > 2) errors.push(`${here}: option nesting too deep`);
  if (!NAME_RE.test(option.name) || option.name !== option.name.toLowerCase()) {
    errors.push(`${here}: invalid option name`);
  }
  if (!option.description || option.description.length > DESC_MAX) {
    errors.push(`${here}: description must be 1-${DESC_MAX} chars`);
  }
  if (option.type === DiscordOptionType.SUB_COMMAND) {
    for (const child of option.options ?? []) {
      if (child.type === DiscordOptionType.SUB_COMMAND) {
        errors.push(`${here}: subcommand cannot nest another subcommand`);
      }
      errors.push(...validateOption(here, child, depth + 1));
    }
  } else if (option.options?.length) {
    errors.push(`${here}: non-subcommand options cannot nest`);
  }
  return errors;
}

export function validateSlashCommandRegistry(
  commands: SlashCommandDefinition[] = getSupportedSlashCommands(),
): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const cmd of commands) {
    if (names.has(cmd.name)) errors.push(`duplicate command name: ${cmd.name}`);
    names.add(cmd.name);
    errors.push(...validateSlashCommandDefinition(cmd));
  }
  // Every MUSIC_COMMANDS entry must appear in the registry.
  for (const music of MUSIC_COMMANDS) {
    if (![...names].some((n) => n === music)) {
      errors.push(`music command ${music} missing from slash registry`);
    }
  }
  return errors;
}

/** Strip internal fields before sending to Discord REST. Guild bodies omit deprecated dm_permission and global-only contexts. */
export function toDiscordCommandBody(cmd: SlashCommandDefinition): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: cmd.type,
    name: cmd.name,
    description: cmd.description,
    default_member_permissions: cmd.default_member_permissions,
  };
  if (cmd.options?.length) body.options = cmd.options.map(toDiscordOptionBody);
  return body;
}

function toDiscordOptionBody(option: SlashOptionDefinition): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: option.type,
    name: option.name,
    description: option.description,
  };
  if (option.required != null) body.required = option.required;
  if (option.options?.length) body.options = option.options.map(toDiscordOptionBody);
  return body;
}

/** Build a Discord interaction `data` object matching this registry entry (for contract tests). */
export function interactionDataForCommand(
  commandName: string,
  opts: {
    subcommand?: string;
    options?: Record<string, string>;
  } = {},
): { name: string; options?: Array<{ name: string; type: number; value?: string; options?: unknown[] }> } {
  if (commandName.startsWith('ts.')) {
    const subName = commandName.slice(3);
    return { name: 'ts', options: [{ name: subName, type: DiscordOptionType.SUB_COMMAND }] };
  }
  if (commandName === 'playlist' || commandName === 'radio') {
    const subName = opts.subcommand ?? 'list';
    const optionEntries = Object.entries(opts.options ?? {}).map(([name, value]) => ({
      name,
      type: DiscordOptionType.STRING,
      value,
    }));
    return {
      name: commandName,
      options: [{
        name: subName,
        type: DiscordOptionType.SUB_COMMAND,
        options: optionEntries,
      }],
    };
  }
  const optionEntries = Object.entries(opts.options ?? {}).map(([name, value]) => ({
    name,
    type: DiscordOptionType.STRING,
    value,
  }));
  return optionEntries.length
    ? { name: commandName, options: optionEntries }
    : { name: commandName };
}

export function ackModeForHandlerCommand(command: string): 'immediate' | 'deferred' {
  return planAcknowledgement(command) === 'deferred' ? 'deferred' : 'immediate';
}
