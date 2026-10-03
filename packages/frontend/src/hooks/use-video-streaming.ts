import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { VideoSourceModeRequest, VideoStreamSettings } from '@ts6/common';
import { settingsApi } from '../api/settings.api';
import { expensiveDiagnosticQueryOptions } from '../lib/demand-driven-query-policy';
import { videoStartDefaults, type VideoStartOptions } from '../lib/video-options';

export const VIDEO_STREAMING_SETTINGS_QUERY_KEY = ['video-streaming-settings'] as const;
export const VIDEO_ENCODER_CAPABILITIES_QUERY_KEY = ['video-encoder-capabilities'] as const;

/** Admin defaults applied to new video streams (global). */
export function useVideoStreamingSettings() {
  return useQuery({
    queryKey: VIDEO_STREAMING_SETTINGS_QUERY_KEY,
    queryFn: () => settingsApi.getVideoStreaming(),
    staleTime: 60_000,
  });
}

/** Global defaults, one server's overrides and the effective result. */
export function useServerVideoStreamingSettings(serverConfigId: number | null | undefined) {
  return useQuery({
    queryKey: [...VIDEO_STREAMING_SETTINGS_QUERY_KEY, 'server', serverConfigId],
    queryFn: () => settingsApi.getServerVideoStreaming(serverConfigId!),
    enabled: !!serverConfigId,
    staleTime: 60_000,
  });
}

export function useUpdateVideoStreamingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<VideoStreamSettings>) => settingsApi.updateVideoStreaming(data),
    onSuccess: (settings) => {
      qc.setQueryData(VIDEO_STREAMING_SETTINGS_QUERY_KEY, settings);
      // Server views merge over the global defaults.
      qc.invalidateQueries({ queryKey: [...VIDEO_STREAMING_SETTINGS_QUERY_KEY, 'server'] });
    },
  });
}

export function useUpdateServerVideoStreamingSettings(serverConfigId: number | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<VideoStreamSettings>) =>
      settingsApi.updateServerVideoStreaming(serverConfigId!, data),
    onSuccess: (detail) =>
      qc.setQueryData([...VIDEO_STREAMING_SETTINGS_QUERY_KEY, 'server', serverConfigId], detail),
  });
}

/**
 * Encoder capabilities run test encodes on the sidecar, so this never fetches
 * on mount, focus or an interval — only when `check()` is called.
 */
export function useVideoEncoderCapabilities() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: VIDEO_ENCODER_CAPABILITIES_QUERY_KEY,
    queryFn: () => settingsApi.getVideoEncoders(false),
    enabled: false,
    ...expensiveDiagnosticQueryOptions,
  });

  const check = async (refresh: boolean) => {
    if (!refresh) {
      await query.refetch();
      return;
    }
    await qc.fetchQuery({
      queryKey: VIDEO_ENCODER_CAPABILITIES_QUERY_KEY,
      queryFn: () => settingsApi.getVideoEncoders(true),
      staleTime: 0,
    });
  };

  return {
    caps: query.data,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    check,
  };
}

/**
 * One console start's video options: the server's effective streaming defaults
 * until the admin changes a field, then their own choices for that server.
 */
export function useVideoStartOptions(
  serverConfigId: number | null | undefined,
  sourceMode: VideoSourceModeRequest = 'auto',
): [VideoStartOptions, (next: VideoStartOptions) => void, boolean] {
  const { data, isLoading } = useServerVideoStreamingSettings(serverConfigId);
  const [chosen, setChosen] = useState<{ serverConfigId: number | null | undefined; options: VideoStartOptions } | null>(null);
  const own = chosen && chosen.serverConfigId === serverConfigId ? chosen.options : null;
  // Until the defaults arrive, a start would send Auto and skip the server's encoder.
  const loading = !own && isLoading;
  return [own ?? videoStartDefaults(data?.effective, sourceMode), (next) => setChosen({ serverConfigId, options: next }), loading];
}
