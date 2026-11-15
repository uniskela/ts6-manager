import {
  createDiscordCommandAdapter,
  type DiscordCommandDeps,
  type DiscordCommandPolicy,
  type GuildBinding,
} from './adapter.js';
import { createMusicCommandService, type MusicServiceDeps } from './music-service.js';
import type { DiscordInteractionFollowUp } from './follow-up.js';

/**
 * Guild binding lookup for Discord commands.
 * Step 1 injects a test double; Step 2 will swap in a persisted store.
 * Do not treat MemoryGuildBindingLookup as production persistence.
 */
export type GuildBindingLookup = {
  get(guildId: string): GuildBinding | null | Promise<GuildBinding | null>;
};

/** Test double only — never auto-installed in production. */
export class MemoryGuildBindingLookup implements GuildBindingLookup {
  constructor(private readonly rows: Map<string, GuildBinding> = new Map()) {}

  async get(guildId: string): Promise<GuildBinding | null> {
    return this.rows.get(guildId) ?? null;
  }

  set(guildId: string, binding: GuildBinding): void {
    this.rows.set(guildId, binding);
  }
}

export type DiscordCommandRuntime = {
  adapter: ReturnType<typeof createDiscordCommandAdapter>;
  /** Null until a real (or explicit test) follow-up is provided — never silent Memory default. */
  followUp: DiscordInteractionFollowUp | null;
  bindings: GuildBindingLookup;
};

/**
 * Compose adapter + music service from injected ports.
 * Real VoiceBotManager / Prisma plug in via MusicServiceDeps without a second queue.
 * Pass `followUp` explicitly; MemoryDiscordFollowUp is test-only and not auto-selected.
 */
export function createDiscordCommandRuntime(opts: {
  bindings: GuildBindingLookup;
  policy: DiscordCommandPolicy;
  music: MusicServiceDeps;
  presence?: DiscordCommandDeps['presence'];
  bridge?: DiscordCommandDeps['bridge'];
  audit?: DiscordCommandDeps['audit'];
  followUp?: DiscordInteractionFollowUp | null;
  nowMs?: () => number;
}): DiscordCommandRuntime {
  const music = createMusicCommandService(opts.music);
  const adapter = createDiscordCommandAdapter({
    bindings: opts.bindings,
    policy: opts.policy,
    presence: opts.presence ?? { async snapshot(_guildId: string) { return null; } },
    bridge: opts.bridge ?? { async health(_guildId: string) { return null; } },
    audit: opts.audit ?? (() => {}),
    music,
    nowMs: opts.nowMs,
  });
  return {
    adapter,
    followUp: opts.followUp ?? null,
    bindings: opts.bindings,
  };
}
