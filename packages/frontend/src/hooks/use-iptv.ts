import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { iptvApi, type IptvPickKey } from '../api/iptv.api';
import type { VideoStartOptions } from '@/lib/video-options';

/** A playlist mutation can change both saved picks and their current channel matches. */
function invalidateIptvLists(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    'iptv-playlists', 'iptv-channels', 'iptv-groups', 'iptv-console-channels',
    'iptv-console-groups', 'iptv-favourites', 'iptv-recent',
  ].map((key) => qc.invalidateQueries({ queryKey: [key] })));
}

/** Load IPTV playlists, optionally scoped to a server. */
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
    onSuccess: () => invalidateIptvLists(qc),
  });
}

export function useUploadIptvPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; serverConfigId: number; file: File }) =>
      iptvApi.uploadPlaylist(data),
    onSuccess: () => invalidateIptvLists(qc),
  });
}

export function useReplaceIptvPlaylistFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: number; file: File }) =>
      iptvApi.replacePlaylistFile(id, file),
    onSuccess: () => invalidateIptvLists(qc),
  });
}

export function useUpdateIptvPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; url?: string; autoRefreshMinutes?: number } }) =>
      iptvApi.updatePlaylist(id, data),
    onSuccess: () => invalidateIptvLists(qc),
  });
}

export function useDeleteIptvPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => iptvApi.deletePlaylist(id),
    onSuccess: () => invalidateIptvLists(qc),
  });
}

export function useRefreshIptvPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => iptvApi.refreshPlaylist(id),
    onSuccess: () => invalidateIptvLists(qc),
  });
}

/** Load legacy per-playlist IPTV groups. */
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

/** Load the paginated server-scoped channel search for the console. */
export function useConsoleIptvChannels(params: {
  serverConfigId: number;
  playlistId?: number;
  group?: string;
  search?: string;
  channelKey?: string;
  channelId?: number;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: ['iptv-console-channels', params],
    queryFn: () => iptvApi.consoleChannels(params),
    placeholderData: keepPreviousData,
  });
}

/** Expose the existing IPTV stream endpoint to console channel rows. */
export function useIptvStream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, channelId, preset, options }: {
      botId: number; channelId: number; preset?: string; options?: VideoStartOptions;
    }) => iptvApi.stream(botId, channelId, options ?? preset),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['iptv-recent'] }),
  });
}

/** Saved picks are server-scoped and refetch after mutations rather than polling. */
export function useIptvFavourites(serverConfigId: number) {
  return useQuery({
    queryKey: ['iptv-favourites', serverConfigId],
    queryFn: () => iptvApi.favourites(serverConfigId),
  });
}

export function useIptvRecent(serverConfigId: number) {
  return useQuery({
    queryKey: ['iptv-recent', serverConfigId],
    queryFn: () => iptvApi.recent(serverConfigId),
  });
}

/** Removing a disappeared pick also clears its recent entry. */
export function useSetIptvFavourite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ favourite, ...pick }: IptvPickKey & { favourite: boolean; removeRecent?: boolean }) =>
      favourite ? iptvApi.addFavourite(pick) : iptvApi.removeFavourite(pick),
    onSuccess: (_data, pick) => Promise.all([
      qc.invalidateQueries({ queryKey: ['iptv-favourites', pick.serverConfigId] }),
      qc.invalidateQueries({ queryKey: ['iptv-recent', pick.serverConfigId] }),
    ]),
  });
}

export function useIptvStop() {
  return useMutation({
    mutationFn: (botId: number) => iptvApi.stop(botId),
  });
}
