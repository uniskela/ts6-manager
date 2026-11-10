import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlaylistVoteSettings } from '@ts6/common';
import { playlistVoteSettingsApi } from '../api/music.api';

export function usePlaylistVoteSettings(configId: number | null, sid: number | null) {
  return useQuery({
    queryKey: ['playlist-vote-settings', configId, sid],
    queryFn: () => playlistVoteSettingsApi.get(configId!, sid!),
    enabled: !!configId && !!sid,
    refetchOnWindowFocus: false,
  });
}

export function useSavePlaylistVoteSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      configId, sid, settings,
    }: { configId: number; sid: number; settings: PlaylistVoteSettings }) =>
      playlistVoteSettingsApi.save(configId, sid, settings),
    onSuccess: (settings, { configId, sid }) =>
      qc.setQueryData(['playlist-vote-settings', configId, sid], settings),
  });
}
