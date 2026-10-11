import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { musicRequestsApi } from '@/api/music-requests.api';

export function useMusicRequests(configId: number | null, botId?: number | null) {
  return useQuery({
    queryKey: ['music-requests', configId, botId ?? null],
    queryFn: () => musicRequestsApi.list(configId!, botId ?? undefined),
    enabled: !!configId,
    refetchInterval: 5000,
  });
}

export function useReplayMusicRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, requestId, botId, enqueue }: {
      configId: number; requestId: number; botId: number; enqueue: boolean;
    }) => musicRequestsApi.replay(configId, requestId, { botId, enqueue }),
    onSuccess: (_, { botId }) => {
      void qc.invalidateQueries({ queryKey: ['music-bot-state', botId] });
      void qc.invalidateQueries({ queryKey: ['bot-media'] });
    },
    onSettled: (_, __, { configId }) => {
      // Replay can discover a deleted file or removed URL and mark it unavailable.
      void qc.invalidateQueries({ queryKey: ['music-requests', configId] });
    },
  });
}
