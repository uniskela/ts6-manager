import type { Express } from 'express';
import type { MediaCommandPermissions } from '@ts6/common';
import { loadMediaCommandPermissions } from '../voice/media-command-permissions.js';
import type { VoiceBot } from '../voice/voice-bot.js';
import {
  createDiscordCommandAdapter,
  type CommandResult,
  type DiscordCommandIntent,
  type DiscordCommandPolicy,
  type GuildBinding,
} from './adapter.js';
import { createPrismaGuildBindingLookup } from './guild-bindings.js';
import { createMusicCommandService, type MusicServiceDeps } from './music-service.js';
import type { DiscordInteractionFollowUp } from './follow-up.js';
import type { DiscordCommandRuntime, GuildBindingLookup } from './runtime.js';
import { createBindingScopedPresence } from './ts-presence-port.js';
import { createDiscordBridgeHealthPort } from './bridge-health-port.js';
import type { BridgeSnapshot, PresenceSnapshot } from './adapter.js';

/** Minimal VoiceBotManager surface — avoids holding a second player/queue. */
export type VoiceBotManagerPort = {
  getBot(id: number): VoiceBot | undefined | null;
};

type BindingPrisma = Parameters<typeof createPrismaGuildBindingLookup>[0] & {
  appSetting?: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>;
  };
};

export type BackendDiscordRuntimeOpts = {
  prisma: BindingPrisma;
  /** Null/undefined → music resolves no bots (fail closed); runtime still builds. */
  voiceBotManager: VoiceBotManagerPort | null | undefined;
  /** Must match DiscordGuildBinding.instanceId; no default-bot fallback across instances. */
  instanceId: string;
  policy: DiscordCommandPolicy;
  virtualServerIdForBot?: (botId: number) => number;
  /**
   * Production installs createDiscordWebhookFollowUp when DISCORD_APPLICATION_ID is set.
   * MemoryDiscordFollowUp is test-only and must be passed explicitly.
   * Null → deferred commands stay 503 (no type-5 without delivery).
   */
  followUp?: DiscordInteractionFollowUp | null;
  identityForUser?: MusicServiceDeps['identityForUser'];
  nowMs?: () => number;
  audit?: (event: { guildId: string; userId: string; command: string; result: string }) => void;
  /**
   * Optional TeamSpeak WebQuery pool for `/ts status|online|channels`.
   * When omitted, presence stays unavailable (fail closed).
   */
  getTsQueryClient?: (serverConfigId: number) => {
    execute(
      sid: number,
      command: string,
      params?: Record<string, unknown>,
      opts?: { priority?: string },
    ): Promise<unknown>;
  } | null;
  /** Optional override for presence (tests). */
  presence?: { snapshot(guildId: string): Promise<PresenceSnapshot | null> };
  /** Optional override for bridge health (tests). */
  bridge?: { health(guildId: string): Promise<BridgeSnapshot | null> };
  /** Discord bridge worker base URL (compose profile). Empty → `/ts bridge` unavailable. */
  discordBridgeUrl?: string;
  discordBridgeSecret?: string;
  /** Lab-only status file path (private-beta JSON). Never used in default compose. */
  discordBridgeStatusFile?: string;
};

function fail(code: CommandResult['code'], content: string): CommandResult {
  return { ok: false, code, ephemeral: true, content, ack: 'immediate' };
}

/**
 * Refuse bindings that belong to another TS6 Manager instance.
 * Revoked rows pass through so the adapter returns unpaired (not a silent remap).
 */
export function createInstanceScopedBindingLookup(
  inner: GuildBindingLookup,
  instanceId: string,
): GuildBindingLookup {
  const expected = instanceId.trim();
  return {
    async get(guildId: string): Promise<GuildBinding | null> {
      const binding = await inner.get(guildId);
      if (!binding) return null;
      if (binding.revoked) return binding;
      if (!expected || binding.instanceId !== expected) return null;
      return binding;
    },
  };
}

/**
 * Live bot must still sit on the binding's authorised serverConfigId.
 * Never substitutes another bot when the expected id is missing or reassigned.
 */
export function resolveBotForBinding(
  manager: VoiceBotManagerPort | null | undefined,
  binding: GuildBinding,
): VoiceBot | null {
  if (!manager || binding.revoked || binding.botId == null) return null;
  const bot = manager.getBot(binding.botId) ?? null;
  if (!bot) return null;
  if (binding.serverConfigId != null && bot.currentConfig.serverConfigId !== binding.serverConfigId) {
    return null;
  }
  return bot;
}

/**
 * Authorisation boundary for music commands:
 * - Binding is re-read from Prisma immediately before music work (no permanent cache).
 * - Mid-flight revoke/reassign after the adapter's first lookup refuses the side effect.
 * - Bot must match binding.botId and binding.serverConfigId on the live manager.
 * Window: anything that already mutated playback before this re-check is outside the boundary
 * (same as TeamSpeak chat once a handler has begun). Discord deferred follow-up is Step 3B.
 */
export function createAuthorisingMusicExecute(
  bindings: GuildBindingLookup,
  inner: { execute(intent: DiscordCommandIntent, binding: GuildBinding | null): Promise<CommandResult> },
  manager: VoiceBotManagerPort | null | undefined,
): { execute(intent: DiscordCommandIntent, binding: GuildBinding | null): Promise<CommandResult> } {
  return {
    async execute(intent, binding) {
      let fresh: GuildBinding | null;
      try {
        fresh = await bindings.get(intent.guildId);
      } catch {
        return fail('unavailable', 'Guild binding lookup is unavailable.');
      }
      if (!fresh || fresh.revoked) {
        return fail('unpaired', 'This Discord server is not connected to TS6 Manager.');
      }
      if (
        !binding
        || fresh.botId !== binding.botId
        || fresh.serverConfigId !== binding.serverConfigId
        || fresh.instanceId !== binding.instanceId
      ) {
        return fail('unpaired', 'This Discord server is not connected to TS6 Manager.');
      }
      if (fresh.botId == null) {
        return fail('unavailable', 'No music bot is configured for this Discord server.');
      }
      if (!resolveBotForBinding(manager, fresh)) {
        return fail('unavailable', 'Music bot is unavailable.');
      }
      return inner.execute(intent, fresh);
    },
  };
}

/**
 * Compose production Discord command runtime from Prisma + VoiceBotManager.
 * Does not enable HTTP, register slash commands, open Discord sockets, or start playback.
 * followUp defaults to null → deferred interactions stay 503 at the HTTP layer.
 */
export function createBackendDiscordCommandRuntime(
  opts: BackendDiscordRuntimeOpts,
): DiscordCommandRuntime | null {
  if (!opts.prisma || typeof opts.instanceId !== 'string' || !opts.instanceId.trim()) {
    return null;
  }

  const prismaLookup = createPrismaGuildBindingLookup(opts.prisma);
  const bindings = createInstanceScopedBindingLookup(prismaLookup, opts.instanceId.trim());
  const manager = opts.voiceBotManager;

  const musicDeps: MusicServiceDeps = {
    getBot(botId: number) {
      if (!manager) return null;
      const bot = manager.getBot(botId) ?? null;
      return bot;
    },
    virtualServerIdForBot: opts.virtualServerIdForBot ?? (() => 1),
    loadMediaPermissions: async (serverConfigId, virtualServerId): Promise<MediaCommandPermissions> => {
      if (!opts.prisma.appSetting) {
        const { defaultMediaCommandPermissions } = await import('../voice/media-command-permissions.js');
        return defaultMediaCommandPermissions();
      }
      return loadMediaCommandPermissions(opts.prisma as any, serverConfigId, virtualServerId);
    },
    identityForUser: opts.identityForUser,
    prisma: opts.prisma as any,
    nowMs: opts.nowMs,
  };

  const baseMusic = createMusicCommandService(musicDeps);
  const music = createAuthorisingMusicExecute(bindings, baseMusic, manager);

  const presence = opts.presence ?? (
    opts.getTsQueryClient
      ? createBindingScopedPresence({
          bindings,
          getClient: opts.getTsQueryClient,
          virtualServerIdForBot: opts.virtualServerIdForBot ?? (() => 1),
        })
      : { async snapshot() { return null; } }
  );
  const bridge = opts.bridge ?? createDiscordBridgeHealthPort({
    baseUrl: opts.discordBridgeUrl,
    secret: opts.discordBridgeSecret,
    statusFilePath: opts.discordBridgeStatusFile,
  });

  const adapter = createDiscordCommandAdapter({
    bindings,
    policy: opts.policy,
    presence,
    bridge,
    audit: opts.audit ?? (() => {}),
    music,
    nowMs: opts.nowMs,
  });

  return {
    adapter,
    followUp: opts.followUp ?? null,
    bindings,
  };
}

/** Install adapter + binding lookup on app.locals. Never auto-installs Memory follow-up. */
export function installDiscordCommandRuntime(
  app: Express,
  runtime: DiscordCommandRuntime | null,
): void {
  if (!runtime) {
    clearDiscordCommandRuntime(app);
    return;
  }
  app.locals.discordCommandAdapter = runtime.adapter;
  app.locals.discordGuildBindingLookup = runtime.bindings;
  // Explicit null: deferred commands must not type-5 without a real follow-up port.
  app.locals.discordInteractionFollowUp = runtime.followUp;
}

export function clearDiscordCommandRuntime(app: Express): void {
  const followUp = app.locals.discordInteractionFollowUp as DiscordInteractionFollowUp | undefined;
  try {
    followUp?.dispose?.();
  } catch {
    /* shutdown must continue */
  }
  delete app.locals.discordCommandAdapter;
  delete app.locals.discordInteractionFollowUp;
  delete app.locals.discordGuildBindingLookup;
}
