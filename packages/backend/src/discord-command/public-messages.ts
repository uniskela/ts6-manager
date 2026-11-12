import { redactDiagnosticText } from '@ts6/common';
import {
  MEDIA_EGRESS_OFF_REFUSAL,
  MEDIA_LINK_UNAVAILABLE,
  MediaEgressError,
} from '../voice/egress/media-egress.js';
import { RADIO_FETCHER_UNAVAILABLE } from '../voice/egress/media-fetcher-client.js';
import { MediaSessionConflictError } from '../voice/media-session.js';
import { QueueFullError } from '../voice/playlist/queue.js';

/** Stable MediaEgressError texts safe to show in Discord/TeamSpeak replies. */
const SAFE_MEDIA_EGRESS_MESSAGES = new Set([
  RADIO_FETCHER_UNAVAILABLE,
  MEDIA_LINK_UNAVAILABLE,
  MEDIA_EGRESS_OFF_REFUSAL,
]);

/**
 * Map unexpected failures to a controlled Discord/TeamSpeak-facing string.
 * Only crafted conflict/queue-full messages and an allowlist of media-egress
 * texts are passed through; other errors use `fallback` so secrets cannot leak.
 */
export function publicCommandError(err: unknown, fallback: string): string {
  if (err instanceof MediaSessionConflictError || err instanceof QueueFullError) {
    return err.message;
  }
  if (err instanceof MediaEgressError && SAFE_MEDIA_EGRESS_MESSAGES.has(err.message)) {
    return err.message;
  }
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[discord-music] ${redactDiagnosticText(detail).slice(0, 200)}`);
  return fallback;
}
