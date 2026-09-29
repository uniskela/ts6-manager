/**
 * Confirm-and-retry for the backend's single-media-session contract: a start
 * that would replace a bot's music/video (or another bot's stream) returns 409
 * `media_session_conflict`; the user confirms and the same request is resent
 * naming the sessions it may replace.
 */

import type { MediaSessionConflictBody, MediaSessionInfo } from '@ts6/common';

export function isMediaSessionConflict(data: unknown): data is MediaSessionConflictBody {
  const d = data as Partial<MediaSessionConflictBody> | null | undefined;
  return !!d && d.reason === 'media_session_conflict' && Array.isArray(d.conflicts);
}

/** Merge `replaceSessionIds` into an axios request body (object, JSON string or empty). */
export function withReplaceSessionIds(data: unknown, ids: string[]): Record<string, unknown> {
  let body: Record<string, unknown> = {};
  if (typeof data === 'string' && data.trim()) {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
    } catch {
      body = {};
    }
  } else if (data && typeof data === 'object' && !Array.isArray(data) && !(data instanceof FormData)) {
    body = { ...(data as Record<string, unknown>) };
  }
  return { ...body, replaceSessionIds: ids };
}

/** "Music “Neon Skyline” on Aurora Radio" / "Video stream from iptv.example on Bravo (starting)". */
export function describeMediaSession(s: MediaSessionInfo): string {
  const what = s.kind === 'music'
    ? `Music${s.label ? ` “${s.label}”` : ''}`
    : `Video stream${s.label ? ` from ${s.label}` : ''}`;
  return `${what} on ${s.botName}${s.state === 'starting' ? ' (starting)' : ''}`;
}

/** Sessions still starting cannot be replaced; the user has to wait. */
export function conflictIsReplaceable(body: MediaSessionConflictBody): boolean {
  return body.conflicts.every((c) => c.state === 'active');
}
