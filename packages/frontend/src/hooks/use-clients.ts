import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clientsApi } from '../api/clients.api';
import { useServerStore } from '../stores/server.store';
import { useVirtualServers } from './use-servers';

export interface ClientActionContext {
  configId: number;
  sid: number;
  clid: number;
}

export interface KickClientInput extends ClientActionContext {
  reasonid: number;
  reasonmsg?: string;
}

export interface BanClientInput extends ClientActionContext {
  time?: number;
  banreason?: string;
}

export interface PokeClientInput extends ClientActionContext {
  msg: string;
}

export function useClients() {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const { data: virtualServers } = useVirtualServers();
  const contextIsValid = !!virtualServers?.some((server: any) => Number(server.virtualserver_id) === s);
  return useQuery({
    queryKey: ['clients', c, s],
    queryFn: () => clientsApi.list(c!, s!),
    enabled: !!c && !!s && contextIsValid,
    refetchInterval: 10000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1500, 300 * 2 ** attempt),
  });
}

export function useClientDatabase() {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useQuery({
    queryKey: ['client-database', c, s],
    queryFn: () => clientsApi.database(c!, s!),
    enabled: !!c && !!s,
  });
}

export function useKickClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, sid, clid, reasonid, reasonmsg }: KickClientInput) =>
      clientsApi.kick(configId, sid, clid, reasonid, reasonmsg),
    onSuccess: (_data, { configId, sid }) =>
      qc.invalidateQueries({ queryKey: ['clients', configId, sid] }),
  });
}

export function useBanClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, sid, clid, time, banreason }: BanClientInput) =>
      clientsApi.ban(configId, sid, clid, time, banreason),
    onSuccess: (_data, { configId, sid }) =>
      qc.invalidateQueries({ queryKey: ['clients', configId, sid] }),
  });
}

export function useMoveClient() {
  const qc = useQueryClient();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useMutation({
    mutationFn: ({ clid, cid }: { clid: number; cid: number }) =>
      clientsApi.move(c!, s!, clid, cid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clients'] }),
  });
}

export function usePokeClient() {
  return useMutation({
    mutationFn: ({ configId, sid, clid, msg }: PokeClientInput) =>
      clientsApi.poke(configId, sid, clid, msg),
  });
}
