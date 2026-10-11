import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { iconsApi } from '../api/icons.api';
import { useServerStore } from '../stores/server.store';

const iconsKey = (configId: number | null, sid: number | null) => ['server-icons', configId, sid] as const;

/** Icons stored on the selected virtual server. */
export function useServerIcons(enabled: boolean) {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useQuery({
    queryKey: iconsKey(c, s),
    queryFn: () => iconsApi.list(c!, s!),
    enabled: enabled && !!c && !!s,
    staleTime: 30_000,
    retry: false,
  });
}

/** Object URL for one icon's image; an icon's bytes never change for its id. */
export function useServerIconImage(id: number) {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const image = useQuery({
    queryKey: ['server-icon-image', c, s, id],
    queryFn: () => iconsApi.image(c!, s!, id),
    enabled: !!c && !!s && id > 0,
    staleTime: Infinity,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image.data) { setUrl(null); return; }
    const objectUrl = URL.createObjectURL(image.data);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image.data]);
  return { url, failed: image.isError };
}

export function useUploadServerIcon() {
  const qc = useQueryClient();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useMutation({
    mutationFn: (file: File) => iconsApi.upload(c!, s!, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: iconsKey(c, s) }),
  });
}

export function useDeleteServerIcon() {
  const qc = useQueryClient();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useMutation({
    mutationFn: (id: number) => iconsApi.remove(c!, s!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: iconsKey(c, s) }),
  });
}
