import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api/dashboard.api';
import { useServerStore } from '../stores/server.store';

export function useDashboard() {
  const { selectedConfigId, selectedSid } = useServerStore();
  return useQuery({
    queryKey: ['dashboard', selectedConfigId, selectedSid],
    queryFn: () => dashboardApi.get(selectedConfigId!, selectedSid!),
    enabled: !!selectedConfigId && !!selectedSid,
    refetchInterval: 10000,
    // First paint can race background Query traffic. Retry ordinary transient
    // failures, but a 429 is an intentional TeamSpeak antiflood cooldown; the
    // normal 10s polling interval becomes the controlled recovery probe.
    retry: (failureCount, error: any) => error?.response?.status !== 429 && failureCount < 3,
    retryDelay: (attempt) => Math.min(1500, 300 * 2 ** attempt),
  });
}
