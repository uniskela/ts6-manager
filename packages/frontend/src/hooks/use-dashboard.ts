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
    // First paint often races AnimationManager / bot traffic on the shared WebQuery socket.
    retry: 3,
    retryDelay: (attempt) => Math.min(1500, 300 * 2 ** attempt),
  });
}
