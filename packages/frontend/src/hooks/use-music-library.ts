import { useEffect, useRef, useState } from 'react';
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

function useDownloadJob(single: boolean) {
  const qc = useQueryClient();
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const mutation = useMutation({
    mutationFn: async ({ configId, url, urls }: { configId: number; url?: string; urls?: string[] }) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      const { signal } = current;
      setProgress('Preparing download…');
      try {
        const { jobId } = await musicLibraryApi.startDownload(configId, urls ?? [url!], signal);
        for (;;) {
          signal.throwIfAborted();
          const job = await musicLibraryApi.downloadStatus(configId, jobId, signal);
          const details = [job.percentage != null ? `${Math.round(job.percentage)}%` : '',
            job.speed != null ? `${(job.speed / 1024).toFixed(0)} KiB/s` : '',
            job.eta != null ? `ETA ${Math.ceil(job.eta)}s` : ''].filter(Boolean).join(' · ');
          setProgress(`${job.status === 'processing' ? 'Processing…' : 'Downloading'} ${job.currentItem}/${job.totalItems}${details ? ` · ${details}` : ''}`);
          if (job.status === 'done' || job.status === 'error') {
            if (job.status === 'error') setProgress(job.error || 'Download failed');
            else setProgress(null);
            if (single && job.status === 'error') throw new Error(job.error || 'Download failed');
            return single ? job.results[0] : job;
          }
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2000);
            signal.addEventListener('abort', abort, { once: true });
          });
        }
      } catch (error) {
        if (!signal.aborted) setProgress(error instanceof Error ? error.message : 'Download failed');
        throw error;
      }
    },
    onSuccess: (_, { configId }) => qc.invalidateQueries({ queryKey: ['songs', configId] }),
  });
  return { ...mutation, progress };
}

export function useYouTubeDownload() { return useDownloadJob(true); }

export function useYouTubeInfo() {
  return useMutation({
    mutationFn: ({ configId, url }: { configId: number; url: string }) =>
      musicLibraryApi.youtubeInfo(configId, url),
  });
}

export function useYouTubeDownloadBatch() { return useDownloadJob(false); }

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
