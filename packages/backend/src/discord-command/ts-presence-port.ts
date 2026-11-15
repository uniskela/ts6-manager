import type { PresenceSnapshot } from './adapter.js';
import type { GuildBindingLookup } from './runtime.js';
import { presenceFromQueryRows } from './presence.js';

type QueryClient = {
  execute(
    sid: number,
    command: string,
    params?: Record<string, unknown>,
    opts?: { priority?: string },
  ): Promise<unknown>;
};

/**
 * Guild-scoped TeamSpeak presence for `/ts status|online|channels`.
 * Uses the guild binding's authorised serverConfigId + virtual server id.
 * Fail closed (null) when unbound, revoked, or the query client is missing.
 */
export function createBindingScopedPresence(opts: {
  bindings: GuildBindingLookup;
  getClient(serverConfigId: number): QueryClient | null;
  virtualServerIdForBot(botId: number): number;
}): { snapshot(guildId: string): Promise<PresenceSnapshot | null> } {
  return {
    async snapshot(guildId: string): Promise<PresenceSnapshot | null> {
      let binding;
      try {
        binding = await opts.bindings.get(guildId);
      } catch {
        return null;
      }
      if (!binding || binding.revoked || binding.serverConfigId == null || binding.botId == null) {
        return null;
      }
      const client = opts.getClient(binding.serverConfigId);
      if (!client) return null;
      const sid = opts.virtualServerIdForBot(binding.botId);
      try {
        const [serverInfoRaw, channelListRaw, clientListRaw] = await Promise.all([
          client.execute(sid, 'serverinfo', undefined, { priority: 'low' }),
          client.execute(sid, 'channellist', undefined, { priority: 'low' }),
          client.execute(sid, 'clientlist', undefined, { priority: 'low' }),
        ]);
        const serverinfo = Array.isArray(serverInfoRaw) ? serverInfoRaw[0] : serverInfoRaw;
        const channels = Array.isArray(channelListRaw) ? channelListRaw : [];
        const clients = Array.isArray(clientListRaw) ? clientListRaw : [];
        return presenceFromQueryRows({
          serverinfo: serverinfo as Record<string, unknown>,
          channels: channels as Record<string, unknown>[],
          clients: clients as Record<string, unknown>[],
        });
      } catch {
        return null;
      }
    },
  };
}
