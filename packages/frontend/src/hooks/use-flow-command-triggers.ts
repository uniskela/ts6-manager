import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { botsApi } from '@/api/bots.api';
import { useBots } from '@/hooks/use-bots';
import { collectFlowCommandNames } from '@/lib/command-clashes';

/** Load every bot flow (list omits flowData) and collect chat-command trigger names. */
export function useFlowCommandTriggers(serverConfigId?: number | null) {
  const { data: bots } = useBots();
  const list = Array.isArray(bots) ? bots : [];
  const serverBots = serverConfigId == null
    ? []
    : list.filter((bot: { serverConfigId?: number }) => bot.serverConfigId === serverConfigId);

  const details = useQueries({
    queries: serverBots.map((bot: { id: number; flowData?: unknown }) => ({
      queryKey: ['bot', bot.id] as const,
      queryFn: () => botsApi.get(bot.id),
      // Test mock list already includes flowData; skip a redundant fetch when present.
      enabled: bot.flowData == null,
      initialData: bot.flowData != null ? bot : undefined,
      staleTime: 30_000,
    })),
  });

  return useMemo(() => {
    const resolved = serverBots.map((bot: { id: number; flowData?: unknown }, i: number) => {
      if (bot.flowData != null) return bot;
      return details[i]?.data ?? bot;
    });

    // The API may return the serialized flowData form used by legacy records.
    // Parse it before collecting nodes so malformed values cannot break clash detection.
    const normalized = resolved.map((bot) => {
      if (typeof bot.flowData !== 'string') return bot;
      try {
        return { ...bot, flowData: JSON.parse(bot.flowData) };
      } catch {
        return { ...bot, flowData: null };
      }
    });
    return collectFlowCommandNames(normalized);
  }, [serverBots, details]);
}
