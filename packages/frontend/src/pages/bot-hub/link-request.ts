/**
 * Pure mapping from the Link tab's input + mode to the play-url / stream/start
 * request bodies. play-url only accepts remote URLs (media-url-pipeline); bare
 * MUSIC_DIR filenames are video-only via stream/start.
 */

import type { StartVideoStreamRequest } from '@ts6/common';
import {
  DEFAULT_VIDEO_START_OPTIONS,
  videoStartRequest,
  type VideoStartOptions,
} from '@/lib/video-options';

export type LinkPlayMode = 'music' | 'video';

export type LinkStartRequest =
  | { endpoint: 'play-url'; body: { url: string } }
  | { endpoint: 'stream/start'; body: StartVideoStreamRequest };

/** True when the input is an http(s) URL (play-url / remote stream source). */
export function isRemoteMediaUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed);
}

/** play-url rejects bare filenames; only remote URLs may use Play as music. */
export function musicPlayAllowed(value: string): boolean {
  return isRemoteMediaUrl(value);
}

export function buildLinkStartRequest(
  input: string,
  mode: LinkPlayMode,
  options: VideoStartOptions = DEFAULT_VIDEO_START_OPTIONS,
): LinkStartRequest {
  const trimmed = input.trim();
  if (mode === 'music') {
    return { endpoint: 'play-url', body: { url: trimmed } };
  }
  return {
    endpoint: 'stream/start',
    body: { source: trimmed, ...videoStartRequest(options) },
  };
}
