import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { musicLibraryApi } from '../api/music.api';

export function useSongs(configId: number | null) {
  return useQuery({
    queryKey: ['songs', configId],
    queryFn: () => musicLibraryApi.songs(configId!),
    enabled: !!configId,
  });
}

export function useScanLibrary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (configId: number) => musicLibraryApi.scan(configId),
    onSuccess: (_, configId) => qc.invalidateQueries({ queryKey: ['songs', configId] }),
  });
}

export function useUploadSong() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, formData }: { configId: number; formData: FormData }) =>
      musicLibraryApi.upload(configId, formData),
    onSuccess: (_, { configId }) => qc.invalidateQueries({ queryKey: ['songs', configId] }),
  });
}

export function useDeleteSong() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, songId }: { configId: number; songId: number }) =>
      musicLibraryApi.deleteSong(configId, songId),
    onSuccess: (_, { configId }) => qc.invalidateQueries({ queryKey: ['songs', configId] }),
  });
}

export function useYouTubeSearch() {
  return useMutation({
    mutationFn: ({ configId, query }: { configId: number; query: string }) =>
      musicLibraryApi.youtubeSearch(configId, query),
  });
}

export function useYouTubeDownload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, url }: { configId: number; url: string }) =>
      musicLibraryApi.youtubeDownload(configId, url),
    onSuccess: (_, { configId }) => qc.invalidateQueries({ queryKey: ['songs', configId] }),
  });
}

export function useYouTubeInfo() {
  return useMutation({
    mutationFn: ({ configId, url }: { configId: number; url: string }) =>
      musicLibraryApi.youtubeInfo(configId, url),
  });
}

export function useYouTubeDownloadBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, urls }: { configId: number; urls: string[] }) =>
      musicLibraryApi.youtubeDownloadBatch(configId, urls),
    onSuccess: (_, { configId }) => qc.invalidateQueries({ queryKey: ['songs', configId] }),
  });
}

export function useYouTubeRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      configId,
      items,
    }: {
      configId: number;
      items: { url: string; title?: string; artist?: string; duration?: number }[];
    }) => musicLibraryApi.youtubeRegister(configId, items),
    onSuccess: (_, { configId }) => qc.invalidateQueries({ queryKey: ['songs', configId] }),
  });
}

export function useYouTubeImportPlaylist() {
  return useMutation({
    mutationFn: ({
      configId,
      url,
      playlistName,
      playlistId,
      reimport,
    }: {
      configId: number;
      url: string;
      playlistName?: string;
      playlistId?: number;
      reimport?: boolean;
    }) => musicLibraryApi.youtubeImportPlaylist(configId, { url, playlistName, playlistId, reimport }),
  });
}

export function useYouTubeImportStatus(configId: number | null, jobId: string | null) {
  return useQuery({
    queryKey: ['yt-import', configId, jobId],
    queryFn: () => musicLibraryApi.youtubeImportStatus(configId!, jobId!),
    enabled: !!configId && !!jobId,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 2000 : false;
    },
  });
}
