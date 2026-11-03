import { isMusicCommand } from './music.js';

export type Ts6Role = 'admin' | 'viewer';

export type DiscordCommandIntent = {
  guildId: string;
  userId: string;
  roleIds: string[];
  memberPermissions: string;
  command: string;
  args?: Record<string, string>;
  idempotencyKey?: string;
  ts6Role?: Ts6Role;
};

export type CommandFailureCode =
  | 'unpaired'
  | 'unauthorized'
  | 'unavailable'
  | 'not_implemented'
  | 'rate_limited'
  | 'invalid_signature'
  | 'replay';

export type CommandResult = {
  ok: boolean;
  code?: CommandFailureCode;
  ephemeral: boolean;
  content: string;
  ack: 'immediate' | 'deferred' | 'pong';
};

export type GuildBinding = {
  instanceId: string;
  revoked: boolean;
  botId?: number;
  /** Authorised TeamSpeak server for this guild (set by persistent bindings). */
  serverConfigId?: number;
};

export type DiscordCommandPolicy = {
  viewerRoleIds: string[];
  adminRoleIds: string[];
  userRoles?: Record<string, Ts6Role>;
};

export type PresenceSnapshot = {
  connected: boolean;
  serverName: string | null;
  nicknames: string[];
  channels: Array<{ name: string }>;
};

export type BridgeSnapshot = {
  daveReady: boolean;
  electedSlot: string;
  generation: number;
  t2dForwarded?: number;
};

export type DiscordAuditEvent = {
  guildId: string;
  userId: string;
  command: string;
  result: 'ok' | CommandFailureCode;
};

export type DiscordCommandDeps = {
  /** Sync or async; persistent stores are async. */
  bindings: { get(guildId: string): GuildBinding | null | Promise<GuildBinding | null> };
  policy: DiscordCommandPolicy;
  presence: { snapshot(): Promise<PresenceSnapshot | null> };
  bridge: { health(): Promise<BridgeSnapshot | null> };
  audit: (event: DiscordAuditEvent) => void;
  rateLimit?: { take(key: string, nowMs: number): boolean };
  nowMs?: () => number;
  music?: { execute(intent: DiscordCommandIntent, binding: GuildBinding | null): Promise<CommandResult> };
};

const MANAGE_GUILD = 1n << 5n;
const HELP = [
  '`/ts help` — this list',
  '`/ts status` — TeamSpeak and bridge status (admin)',
  '`/ts online` — connected TeamSpeak users',
  '`/ts channels` — channel names',
  '`/ts bridge` — connection and audio health (admin)',
].join('\n');

function fail(code: CommandFailureCode, content: string): CommandResult {
  return { ok: false, code, ephemeral: true, content, ack: 'immediate' };
}

function ok(content: string, ephemeral = false): CommandResult {
  return { ok: true, ephemeral, content, ack: 'immediate' };
}

function hasBit(permissions: string, bit: bigint): boolean {
  try {
    return (BigInt(permissions) & bit) === bit;
  } catch {
    return false;
  }
}

export function hasManageGuild(permissions: string): boolean {
  return hasBit(permissions, MANAGE_GUILD);
}

/** Discord Manage Guild is for pair/unpair only — it is not a TS6 admin grant. */
export function resolveTs6Role(intent: DiscordCommandIntent, policy: DiscordCommandPolicy): Ts6Role | null {
  const mapped = policy.userRoles?.[intent.userId];
  if (mapped) return mapped;
  if (intent.roleIds.some((id) => policy.adminRoleIds.includes(id))) return 'admin';
  if (intent.roleIds.some((id) => policy.viewerRoleIds.includes(id))) return 'viewer';
  return null;
}

function needsAdmin(command: string): boolean {
  return command === 'ts.status' || command === 'ts.bridge';
}

export function createDiscordCommandAdapter(deps: DiscordCommandDeps) {
  async function handle(intent: DiscordCommandIntent): Promise<CommandResult> {
    const result = await dispatch(intent);
    deps.audit({
      guildId: intent.guildId,
      userId: intent.userId,
      command: intent.command,
      result: result.ok ? 'ok' : (result.code ?? 'unavailable'),
    });
    return result;
  }

  async function dispatch(intent: DiscordCommandIntent): Promise<CommandResult> {
    const nowMs = deps.nowMs?.() ?? Date.now();
    if (deps.rateLimit && !deps.rateLimit.take(`${intent.guildId}:${intent.userId}`, nowMs)) {
      return fail('rate_limited', 'You are sending commands too quickly.');
    }

    let binding: GuildBinding | null;
    try {
      binding = await deps.bindings.get(intent.guildId);
    } catch {
      return fail('unavailable', 'Guild binding lookup is unavailable.');
    }
    if (!binding || binding.revoked) {
      return fail('unpaired', 'This Discord server is not connected to TS6 Manager.');
    }

    const role = resolveTs6Role(intent, deps.policy);
    if (!role) return fail('unauthorized', 'You do not have permission to use this command.');
    if (needsAdmin(intent.command) && role !== 'admin') {
      return fail('unauthorized', 'You do not have permission to use this command.');
    }

    if (isMusicCommand(intent.command)) {
      if (!deps.music) return fail('not_implemented', 'Music commands are not available yet.');
      return deps.music.execute({ ...intent, ts6Role: role }, binding);
    }

    if (intent.command === 'ts.help') return ok(HELP);

    if (intent.command === 'ts.bridge') {
      try {
        const health = await deps.bridge.health();
        if (!health) return fail('unavailable', 'Bridge status is unavailable.');
        return ok(
          [
            `daveReady=${health.daveReady}`,
            `slot=${health.electedSlot}`,
            `generation=${health.generation}`,
            health.t2dForwarded != null ? `t2dForwarded=${health.t2dForwarded}` : null,
          ].filter(Boolean).join('\n'),
          true,
        );
      } catch {
        return fail('unavailable', 'Bridge status is unavailable.');
      }
    }

    try {
      const presence = await deps.presence.snapshot();
      if (!presence) return fail('unavailable', 'TeamSpeak is unavailable.');
      if (intent.command === 'ts.status') {
        return ok(
          presence.connected ? `Connected to ${presence.serverName ?? 'TeamSpeak'}` : 'TeamSpeak is disconnected.',
          true,
        );
      }
      if (intent.command === 'ts.online') {
        return ok(presence.nicknames.length ? presence.nicknames.join('\n') : 'No one is online.', true);
      }
      if (intent.command === 'ts.channels') {
        return ok(presence.channels.length ? presence.channels.map((c) => c.name).join('\n') : 'No channels.', true);
      }
    } catch {
      return fail('unavailable', 'TeamSpeak is unavailable.');
    }

    return fail('unauthorized', 'Unknown command.');
  }

  return { handle };
}
