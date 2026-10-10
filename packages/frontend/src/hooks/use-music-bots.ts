import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { musicBotsApi } from '../api/music.api';
import type { StartVideoStreamRequest } from '@ts6/common';

export function useMusicBots() {
  return useQuery({
    queryKey: ['music-bots'],
    queryFn: musicBotsApi.list,
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
  });
}

export function useMusicBot(id: number | null) {
  return useQuery({
    queryKey: ['music-bot', id],
    queryFn: () => musicBotsApi.get(id!),
    enabled: !!id,
  });
}

export function useCreateMusicBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => musicBotsApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['music-bots'] }),
  });
}

export function useUpdateMusicBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => musicBotsApi.update(id, data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['music-bots'] });
      qc.invalidateQueries({ queryKey: ['music-bot', id] });
    },
  });
}

export function useDeleteMusicBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => musicBotsApi.delete(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['music-bots'] });
      void qc.invalidateQueries({ queryKey: ['bot-media'] });
    },
  });
}

export function useUploadBotAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, file }: { botId: number; file: File }) => musicBotsApi.uploadAvatar(botId, file),
    onSuccess: async (_, { botId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['music-bots'] }),
        qc.invalidateQueries({ queryKey: ['music-bot', botId] }),
        qc.invalidateQueries({ queryKey: ['bot-media'] }),
        qc.invalidateQueries({ queryKey: ['music-bot-avatar', botId] }),
      ]);
    },
  });
}

export function useSetBotAvatarMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, mode }: { botId: number; mode: 'custom' | 'default' | 'none' }) =>
      musicBotsApi.avatarMode(botId, mode),
    onSuccess: async (_, { botId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['music-bots'] }),
        qc.invalidateQueries({ queryKey: ['music-bot', botId] }),
        qc.invalidateQueries({ queryKey: ['bot-media'] }),
        qc.invalidateQueries({ queryKey: ['music-bot-avatar', botId] }),
      ]);
    },
  });
}

export function useStartMusicBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => musicBotsApi.start(id),
    onSuccess: () => {
      void qc.refetchQueries({ queryKey: ['music-bots'] });
      void qc.refetchQueries({ queryKey: ['bot-media'] });
    },
  });
}

export function useStopMusicBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => musicBotsApi.stop(id),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: ['music-bot-state', id] });
      void qc.refetchQueries({ queryKey: ['music-bots'] });
      void qc.refetchQueries({ queryKey: ['bot-media'] });
    },
  });
}

export function useRestartMusicBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => musicBotsApi.restart(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['music-bots'] }),
  });
}

export function useMusicBotState(id: number | null) {
  return useQuery({
    queryKey: ['music-bot-state', id],
    queryFn: () => musicBotsApi.state(id!),
    enabled: !!id,
    refetchInterval: 2000,
  });
}

export function usePlaySong() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, songId }: { botId: number; songId: number }) =>
      musicBotsApi.play(botId, songId),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function usePlayUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, url, enqueue }: { botId: number; url: string; enqueue?: boolean }) =>
      musicBotsApi.playUrl(botId, url, { enqueue }),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function usePausePlayback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (botId: number) => musicBotsApi.pause(botId),
    onSuccess: (_, botId) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function useResumePlayback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (botId: number) => musicBotsApi.resume(botId),
    onSuccess: (_, botId) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function useStopPlayback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (botId: number) => musicBotsApi.stopPlayback(botId),
    onSuccess: (_, botId) => {
      qc.invalidateQueries({ queryKey: ['music-bot-state', botId] });
      qc.invalidateQueries({ queryKey: ['bot-media'] });
    },
  });
}

export function useSkipTrack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (botId: number) => musicBotsApi.skip(botId),
    onSuccess: (_, botId) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function usePreviousTrack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (botId: number) => musicBotsApi.previous(botId),
    onSuccess: (_, botId) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function useSeek() {
  return useMutation({
    mutationFn: ({ botId, seconds }: { botId: number; seconds: number }) =>
      musicBotsApi.seek(botId, seconds),
  });
}

export function useSetVolume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, volume }: { botId: number; volume: number }) =>
      musicBotsApi.volume(botId, volume),
    onSuccess: (_, { botId }) => {
      qc.invalidateQueries({ queryKey: ['music-bot-state', botId] });
      qc.invalidateQueries({ queryKey: ['music-bots'] });
    },
  });
}

export function useEnqueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, songId }: { botId: number; songId: number }) =>
      musicBotsApi.enqueue(botId, songId),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function useLoadPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, playlistId, clearFirst }: { botId: number; playlistId: number; clearFirst?: boolean }) =>
      musicBotsApi.loadPlaylist(botId, playlistId, clearFirst),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function useRemoveFromQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, index }: { botId: number; index: number }) =>
      musicBotsApi.removeFromQueue(botId, index),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function useClearQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (botId: number) => musicBotsApi.clearQueue(botId),
    onSuccess: (_, botId) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function useSetShuffle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, enabled }: { botId: number; enabled: boolean }) =>
      musicBotsApi.shuffle(botId, enabled),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function useSetRepeat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, mode }: { botId: number; mode: string }) =>
      musicBotsApi.repeat(botId, mode),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function usePlayFromQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, index }: { botId: number; index: number }) =>
      musicBotsApi.playFromQueue(botId, index),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

export function useMoveQueueItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, from, to }: { botId: number; from: number; to: number }) =>
      musicBotsApi.moveQueueItem(botId, from, to),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['music-bot-state', botId] }),
  });
}

// === Video Streaming Hooks ===

export function useVideoStreamStatus(botId: number | null) {
  return useQuery({
    queryKey: ['video-stream-status', botId],
    queryFn: () => musicBotsApi.streamStatus(botId!),
    enabled: !!botId,
    refetchInterval: 2000,
  });
}

export function useStartVideoStream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, ...request }: { botId: number } & StartVideoStreamRequest) =>
      musicBotsApi.startStream(botId, request),
    onSuccess: (_, { botId }) => {
      qc.invalidateQueries({ queryKey: ['video-stream-status', botId] });
      qc.invalidateQueries({ queryKey: ['music-bot-state', botId] });
    },
  });
}

export function useStopVideoStream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (botId: number) => musicBotsApi.stopStream(botId),
    onSuccess: (_, botId) => {
      qc.invalidateQueries({ queryKey: ['bot-media'] });
      qc.invalidateQueries({ queryKey: ['video-stream-status', botId] });
      qc.invalidateQueries({ queryKey: ['music-bot-state', botId] });
    },
  });
}

export function useSetStreamSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, source, volume }: { botId: number; source: string; volume?: number }) =>
      musicBotsApi.setStreamSource(botId, source, volume),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['video-stream-status', botId] }),
  });
}

export function useSetStreamVolume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, volume }: { botId: number; volume: number }) =>
      musicBotsApi.setStreamVolume(botId, volume),
    onSuccess: (_, { botId }) => {
      qc.invalidateQueries({ queryKey: ['video-stream-status', botId] });
      qc.invalidateQueries({ queryKey: ['music-bot-state', botId] });
      qc.invalidateQueries({ queryKey: ['music-bots'] });
    },
  });
}

export function useKickVideoViewer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, clid }: { botId: number; clid: number }) =>
      musicBotsApi.kickViewer(botId, clid),
    onSuccess: (_, { botId }) => qc.invalidateQueries({ queryKey: ['video-stream-status', botId] }),
  });
}

// === Video queue ===

export function useVideoQueue(botId: number | null) {
  return useQuery({
    queryKey: ['video-queue', botId],
    queryFn: () => musicBotsApi.videoQueue(botId!),
    enabled: !!botId,
    refetchInterval: 2000,
  });
}

/** Every video queue change shows in Up next and can start or stop a stream. */
function useVideoQueueMutation<TVariables extends { botId: number }, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: (_data, _error, { botId }) => {
      qc.invalidateQueries({ queryKey: ['video-queue', botId] });
      qc.invalidateQueries({ queryKey: ['bot-media'] });
    },
  });
}

export function useQueueVideo() {
  return useVideoQueueMutation(({ botId, ...request }: { botId: number } & StartVideoStreamRequest) =>
    musicBotsApi.queueVideo(botId, request));
}

export function usePlayVideoQueue() {
  return useVideoQueueMutation(({ botId, ...request }: { botId: number } & Partial<StartVideoStreamRequest>) =>
    musicBotsApi.playVideoQueue(botId, request));
}

export function useSkipVideo() {
  return useVideoQueueMutation(({ botId }: { botId: number }) => musicBotsApi.skipVideo(botId));
}

export function usePlayQueuedVideo() {
  return useVideoQueueMutation(
    ({ botId, index, ...request }: { botId: number; index: number } & Partial<StartVideoStreamRequest>) =>
      musicBotsApi.playQueuedVideo(botId, index, request),
  );
}

export function useRemoveQueuedVideo() {
  return useVideoQueueMutation(({ botId, index }: { botId: number; index: number }) =>
    musicBotsApi.removeQueuedVideo(botId, index));
}

export function useMoveQueuedVideo() {
  return useVideoQueueMutation(({ botId, from, to }: { botId: number; from: number; to: number }) =>
    musicBotsApi.moveQueuedVideo(botId, from, to));
}

export function useClearVideoQueue() {
  return useVideoQueueMutation(({ botId }: { botId: number }) => musicBotsApi.clearVideoQueue(botId));
}

// === Bot hub ===

export function useBotMedia() {
  return useQuery({
    queryKey: ['bot-media'],
    queryFn: musicBotsApi.media,
    refetchInterval: 3000,
  });
}
