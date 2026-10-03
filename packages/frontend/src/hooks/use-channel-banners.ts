import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { channelBannersApi } from '../api/channel-banners.api';

export const CHANNEL_BANNERS_QUERY_KEY = ['channel-banners'] as const;

/** Banners hosted by this manager, with their public links (admins only). */
export function useChannelBanners(enabled: boolean) {
  return useQuery({
    queryKey: CHANNEL_BANNERS_QUERY_KEY,
    queryFn: () => channelBannersApi.list(),
    enabled,
    staleTime: 30_000,
  });
}

export function useUploadChannelBanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => channelBannersApi.upload(file),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHANNEL_BANNERS_QUERY_KEY }),
  });
}

export function useDeleteChannelBanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => channelBannersApi.remove(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHANNEL_BANNERS_QUERY_KEY }),
  });
}

export function useUpdatePublicUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (publicUrl: string) => channelBannersApi.updatePublicUrl(publicUrl),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHANNEL_BANNERS_QUERY_KEY }),
  });
}
