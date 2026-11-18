import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/settings.api';

export const RADIO_NETWORK_QUERY_KEY = ['radio-network-settings'] as const;

/** Admin-approved LAN hosts for radio stations (admins only). */
export function useRadioNetworkSettings(enabled: boolean) {
  return useQuery({
    queryKey: RADIO_NETWORK_QUERY_KEY,
    queryFn: () => settingsApi.getRadioNetwork(),
    enabled,
    staleTime: 60_000,
  });
}

export function useUpdateRadioNetworkSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hosts: string[]) => settingsApi.updateRadioNetwork(hosts),
    onSuccess: (data) => qc.setQueryData(RADIO_NETWORK_QUERY_KEY, data),
  });
}
