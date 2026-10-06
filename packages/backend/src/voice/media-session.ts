/**
 * Single active media session rules (1.9.0).
 *
 * - A bot plays music or video, never both.
 * - Only one video stream runs at a time: every bot shares the one media
 *   sidecar (Docker) or its fixed port (local mode).
 *
 * Starting media that would replace another session requires the caller to
 * name that session's ID (`replaceSessionIds`), so double clicks, concurrent
 * admins and chat commands cannot silently stop each other's media.
 */

import { randomUUID } from 'crypto';
import type { MediaKind, MediaSessionInfo } from '@ts6/common';
import { AppError } from '../middleware/error-handler.js';

export class MediaSessionConflictError extends AppError {
  constructor(
    public requested: MediaKind,
    public conflicts: MediaSessionInfo[],
  ) {
    const other = conflicts[0];
    const what = other
      ? `${other.kind === 'video' ? 'A video stream' : 'Music'} is ${other.state === 'starting' ? 'starting' : 'playing'} on ${other.botName}`
      : 'Another media session is active';
    super(
      409,
      `${what}. Starting ${requested === 'video' ? 'the video stream' : 'music'} will stop it.`,
      'Confirm the switch to replace the active media session.',
      { reason: 'media_session_conflict' },
    );
    this.name = 'MediaSessionConflictError';
  }
}

export function newMediaSessionId(): string {
  return randomUUID();
}

/** Normalize `replaceSessionIds` (array) or a legacy single `replaceSessionId`. */
export function parseReplaceSessionIds(body: unknown): string[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.replaceSessionIds)
    ? b.replaceSessionIds
    : b.replaceSessionId != null ? [b.replaceSessionId] : [];
  return raw
    .filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v))
    .slice(0, 4);
}

/**
 * A label that is safe to show and audit: host for URLs (never path, query or
 * userinfo, which can carry IPTV credentials), base name for local files.
 */
export function safeSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  const trimmed = source.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname || null;
    } catch {
      return null;
    }
  }
  const base = trimmed.split(/[\\/]/).pop() ?? '';
  return base.startsWith('.stream-') ? 'Downloaded video' : base || null;
}
