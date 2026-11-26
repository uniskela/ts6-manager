import { settingsApi } from '../api/settings.api';
import { useLocalHostsSettings, useUpdateLocalHostsSettings } from './use-local-hosts-settings';

export const RADIO_NETWORK_QUERY_KEY = ['radio-network-settings'] as const;

/** Admin-approved LAN hosts for radio stations (admins only). */
export function useRadioNetworkSettings(enabled: boolean) {
  return useLocalHostsSettings(RADIO_NETWORK_QUERY_KEY, settingsApi.getRadioNetwork, enabled);
}

export function useUpdateRadioNetworkSettings() {
  return useUpdateLocalHostsSettings(RADIO_NETWORK_QUERY_KEY, settingsApi.updateRadioNetwork);
}
