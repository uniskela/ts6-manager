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

/** Reads a blob into a `data:` URL. */
function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read icon'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read icon'));
    reader.readAsDataURL(blob);
  });
}

/**
 * `data:` URL for one icon's image; an icon's bytes never change for its id.
 * Not a `blob:` URL: those share this app's origin, so an SVG icon opened in its own tab could
 * run script with the signed-in session. A `data:` document gets an opaque origin instead.
 */
export function useServerIconImage(id: number) {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const image = useQuery({
    queryKey: ['server-icon-image', c, s, id],
    queryFn: () => iconsApi.image(c!, s!, id).then(toDataUrl),
    enabled: !!c && !!s && id > 0,
    staleTime: Infinity,
    retry: false,
  });
  return { url: image.data ?? null, failed: image.isError };
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
