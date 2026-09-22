import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api/dashboard.api';
import { useServerStore } from '../stores/server.store';
import { useVirtualServers } from './use-servers';
import { teamSpeakQueryRetry, teamSpeakQueryRetryDelay } from '@/lib/api-error';

export function useDashboard() {
  const { selectedConfigId, selectedSid } = useServerStore();
  const { data: virtualServers } = useVirtualServers();
  const contextIsValid = !!virtualServers?.some((server: any) => Number(server.virtualserver_id) === selectedSid);
  return useQuery({
    queryKey: ['dashboard', selectedConfigId, selectedSid],
    queryFn: () => dashboardApi.get(selectedConfigId!, selectedSid!),
    enabled: !!selectedConfigId && !!selectedSid && contextIsValid,
    refetchInterval: 10000,
    // First paint can race background Query traffic. Retry ordinary transient
    // failures and cold-start 503s; a 429 is an intentional antiflood cooldown.
    retry: teamSpeakQueryRetry,
    retryDelay: teamSpeakQueryRetryDelay,
  });
}
