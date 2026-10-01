/**
 * Poll bot-media and toast when a stream/music session stops unexpectedly.
 * Seeds on first load so historical lastStop rows do not spam on refresh.
 */

import { useEffect, useRef } from 'react';
import { useBotMedia } from '@/hooks/use-music-bots';
import {
  applyMediaStopToastDelta,
  type MediaStopToastKey,
} from '@/lib/media-stop-toast';

export function useMediaStopToasts(enabled: boolean): void {
  const query = useBotMedia();
  const seenRef = useRef<Set<MediaStopToastKey> | null>(null);

  useEffect(() => {
    if (!enabled || !query.data) return;
    seenRef.current = applyMediaStopToastDelta(query.data, seenRef.current);
  }, [enabled, query.data]);
}
