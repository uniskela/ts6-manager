import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/settings.api';

export const IPTV_NETWORK_QUERY_KEY = ['iptv-network-settings'] as const;

/** Admin-approved LAN hosts for IPTV sources (admins only). */
export function useIptvNetworkSettings(enabled: boolean) {
  return useQuery({
    queryKey: IPTV_NETWORK_QUERY_KEY,
    queryFn: () => settingsApi.getIptvNetwork(),
    enabled,
    staleTime: 60_000,
  });
}

export function useUpdateIptvNetworkSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hosts: string[]) => settingsApi.updateIptvNetwork(hosts),
    onSuccess: (data) => qc.setQueryData(IPTV_NETWORK_QUERY_KEY, data),
  });
}
