import { redactDiagnosticText } from '@ts6/common';
import { MediaEgressError } from '../voice/egress/media-egress.js';
import { MediaSessionConflictError } from '../voice/media-session.js';
import { QueueFullError } from '../voice/playlist/queue.js';

/**
 * Map unexpected failures to a controlled Discord/TeamSpeak-facing string.
 * Only crafted conflict/queue-full/media-egress messages are passed through;
 * other AppErrors and internals use `fallback` so secrets in err.message cannot leak.
 */
export function publicCommandError(err: unknown, fallback: string): string {
  if (
    err instanceof MediaSessionConflictError
    || err instanceof QueueFullError
    || err instanceof MediaEgressError
  ) {
    return err.message;
  }
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[discord-music] ${redactDiagnosticText(detail).slice(0, 200)}`);
  return fallback;
}
