import { settingsApi } from '../api/settings.api';
import { useLocalHostsSettings, useUpdateLocalHostsSettings } from './use-local-hosts-settings';

export const IPTV_NETWORK_QUERY_KEY = ['iptv-network-settings'] as const;

/** Admin-approved LAN hosts for IPTV sources (admins only). */
export function useIptvNetworkSettings(enabled: boolean) {
  return useLocalHostsSettings(IPTV_NETWORK_QUERY_KEY, settingsApi.getIptvNetwork, enabled);
}

export function useUpdateIptvNetworkSettings() {
  return useUpdateLocalHostsSettings(IPTV_NETWORK_QUERY_KEY, settingsApi.updateIptvNetwork);
}
