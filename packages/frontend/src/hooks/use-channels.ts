import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { channelsApi } from '../api/channels.api';
import { useServerStore } from '../stores/server.store';
import { useVirtualServers } from './use-servers';
import { teamSpeakQueryRetry, teamSpeakQueryRetryDelay } from '@/lib/api-error';

export function useChannels() {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const { data: virtualServers } = useVirtualServers();
  const contextIsValid = !!virtualServers?.some((server: any) => Number(server.virtualserver_id) === s);
  return useQuery({
    queryKey: ['channels', c, s],
    queryFn: () => channelsApi.list(c!, s!),
    enabled: !!c && !!s && contextIsValid,
    refetchInterval: 15000,
    retry: teamSpeakQueryRetry,
    retryDelay: teamSpeakQueryRetryDelay,
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useMutation({
    mutationFn: (data: any) => channelsApi.create(c!, s!, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useMutation({
    mutationFn: (cid: number) => channelsApi.delete(c!, s!, cid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
}

export function useEditChannel() {
  const qc = useQueryClient();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useMutation({
    mutationFn: ({ cid, data }: { cid: number; data: any }) => channelsApi.edit(c!, s!, cid, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
}

export function useMoveChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, sid, cid, data }: { configId: number; sid: number; cid: number; data: any }) =>
      channelsApi.move(configId, sid, cid, data),
    onSuccess: (_data, variables) => qc.invalidateQueries({ queryKey: ['channels', variables.configId, variables.sid] }),
  });
}
