import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { iptvApi } from '../api/iptv.api';
import type { VideoStartOptions } from '@/lib/video-options';

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

export function useUploadIptvPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; serverConfigId: number; file: File }) =>
      iptvApi.uploadPlaylist(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['iptv-playlists'] }),
  });
}

export function useReplaceIptvPlaylistFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: number; file: File }) =>
      iptvApi.replacePlaylistFile(id, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['iptv-playlists'] });
      qc.invalidateQueries({ queryKey: ['iptv-channels'] });
      qc.invalidateQueries({ queryKey: ['iptv-groups'] });
    },
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
      qc.invalidateQueries({ queryKey: ['iptv-groups'] });
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

/** Load the server-scoped group list used by the bot console. */
export function useConsoleIptvGroups(serverConfigId: number, playlistId?: number) {
  return useQuery({
    queryKey: ['iptv-console-groups', serverConfigId, playlistId ?? null],
    queryFn: () => iptvApi.consoleGroups(serverConfigId, playlistId),
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

export function useConsoleIptvChannels(params: {
  serverConfigId: number;
  playlistId?: number;
  group?: string;
  search?: string;
  channelKey?: string;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: ['iptv-console-channels', params],
    queryFn: () => iptvApi.consoleChannels(params),
    placeholderData: keepPreviousData,
  });
}

export function useIptvStream() {
  return useMutation({
    mutationFn: ({ botId, channelId, preset, options }: {
      botId: number; channelId: number; preset?: string; options?: VideoStartOptions;
    }) => iptvApi.stream(botId, channelId, options ?? preset),
  });
}

export function useIptvStop() {
  return useMutation({
    mutationFn: (botId: number) => iptvApi.stop(botId),
  });
}
