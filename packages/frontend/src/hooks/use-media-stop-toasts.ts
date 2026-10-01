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
  const sessionStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Signed out: the next session seeds afresh instead of diffing against this one.
      seenRef.current = null;
      sessionStartRef.current = null;
      return;
    }
    sessionStartRef.current ??= Date.now();
    // The query cache outlives a sign-out, so a snapshot fetched before this
    // session began would seed the wrong baseline. Wait for a fresh one.
    if (!query.data || query.dataUpdatedAt < sessionStartRef.current) return;
    seenRef.current = applyMediaStopToastDelta(query.data, seenRef.current);
  }, [enabled, query.data, query.dataUpdatedAt]);
}
