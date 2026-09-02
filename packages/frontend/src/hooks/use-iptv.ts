import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { iptvApi } from '../api/iptv.api';

export function useIptvPlaylists(serverConfigId?: number) {
  return useQuery({
    queryKey: ['iptv-playlists', serverConfigId ?? null],
    queryFn: () => iptvApi.playlists(serverConfigId),
  });
}

export function useCreateIptvPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; url: string; serverConfigId: number; autoRefreshMinutes?: number }) =>
      iptvApi.createPlaylist(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['iptv-playlists'] }),
  });
}

export function useUpdateIptvPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; url?: string; autoRefreshMinutes?: number } }) =>
      iptvApi.updatePlaylist(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['iptv-playlists'] }),
  });
}

export function useDeleteIptvPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => iptvApi.deletePlaylist(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['iptv-playlists'] }),
  });
}

export function useRefreshIptvPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => iptvApi.refreshPlaylist(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['iptv-playlists'] });
      qc.invalidateQueries({ queryKey: ['iptv-channels'] });
    },
  });
}

export function useIptvGroups(playlistId: number | null) {
  return useQuery({
    queryKey: ['iptv-groups', playlistId],
    queryFn: () => iptvApi.groups(playlistId!),
    enabled: !!playlistId,
  });
}

export function useIptvChannels(
  playlistId: number | null,
  params: { search?: string; group?: string; page?: number; pageSize?: number },
) {
  return useQuery({
    queryKey: ['iptv-channels', playlistId, params],
    queryFn: () => iptvApi.channels(playlistId!, params),
    enabled: !!playlistId,
    placeholderData: keepPreviousData,
  });
}

export function useIptvStream() {
  return useMutation({
    mutationFn: ({ botId, channelId, preset }: { botId: number; channelId: number; preset?: string }) =>
      iptvApi.stream(botId, channelId, preset),
  });
}

export function useIptvStop() {
  return useMutation({
    mutationFn: (botId: number) => iptvApi.stop(botId),
  });
}
