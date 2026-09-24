import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { serversApi } from '../api/servers.api';
import { useServerStore } from '../stores/server.store';
import { teamSpeakQueryRetry, teamSpeakQueryRetryDelay, isTeamSpeakStarting } from '@/lib/api-error';

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: serversApi.list,
  });
}

export function useVirtualServers() {
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const connectionIsKnown = !!selectedConfigId && servers?.some((server: any) => Number(server.id) === selectedConfigId);
  return useQuery({
    queryKey: ['virtual-servers', selectedConfigId],
    queryFn: () => serversApi.listVirtual(selectedConfigId!),
    enabled: !!connectionIsKnown,
    retry: teamSpeakQueryRetry,
    retryDelay: teamSpeakQueryRetryDelay,
    refetchInterval: (query) => {
      const err = query.state.error;
      if (!err) return false;
      // Keep probing while Query is still coming up after compose.
      if (isTeamSpeakStarting(err)) return 5_000;
      if ((err as any)?.response?.status === 429) return 15_000;
      return false;
    },
  });
}

export function useVirtualServerInfo() {
  const { selectedConfigId, selectedSid } = useServerStore();
  return useQuery({
    queryKey: ['virtual-server-info', selectedConfigId, selectedSid],
    queryFn: () => serversApi.getVirtualInfo(selectedConfigId!, selectedSid!),
    enabled: !!selectedConfigId && !!selectedSid,
  });
}

interface VirtualServerActionInput {
  configId: number;
  sid: number;
}

export function useStartVirtualServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, sid }: VirtualServerActionInput) =>
      serversApi.startVirtual(configId, sid),
    onSuccess: (_data, { configId }) =>
      qc.invalidateQueries({ queryKey: ['virtual-servers', configId] }),
  });
}

export function useStopVirtualServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, sid }: VirtualServerActionInput) =>
      serversApi.stopVirtual(configId, sid),
    onSuccess: (_data, { configId }) =>
      qc.invalidateQueries({ queryKey: ['virtual-servers', configId] }),
  });
}

export function useCreateServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => serversApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (id: number) => serversApi.test(id),
  });
}
