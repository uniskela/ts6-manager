/**
 * Pure mapping from the Link tab's input + mode to the play-url / stream/start
 * / stream/queue request bodies. play-url only accepts remote URLs
 * (media-url-pipeline); bare MUSIC_DIR filenames are video-only.
 */

import type { QueueVideoResponse, StartVideoStreamRequest } from '@ts6/common';
import {
  DEFAULT_VIDEO_START_OPTIONS,
  videoStartRequest,
  type VideoStartOptions,
} from '@/lib/video-options';

export type LinkPlayMode = 'music' | 'video';

export type LinkStartRequest =
  | { endpoint: 'play-url'; body: { url: string } }
  | { endpoint: 'stream/start'; body: StartVideoStreamRequest }
  | { endpoint: 'stream/queue'; body: StartVideoStreamRequest };

const YOUTUBE_PLAYLIST_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/** A YouTube playlist link with no video in it: the queue adds every video. */
export function isBarePlaylistUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!isRemoteMediaUrl(trimmed)) return false;
  let host: string;
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return false;
  }
  return YOUTUBE_PLAYLIST_HOSTS.has(host) && /[?&]list=/.test(trimmed) && !/[?&]v=/.test(trimmed);
}

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
  videoStreaming = false,
): LinkStartRequest {
  const trimmed = input.trim();
  if (mode === 'music') {
    return { endpoint: 'play-url', body: { url: trimmed } };
  }
  return {
    // A running stream gets the video queued behind it; a playlist always goes
    // through the queue, which starts its first video when nothing is streaming.
    endpoint: videoStreaming || isBarePlaylistUrl(trimmed) ? 'stream/queue' : 'stream/start',
    body: { source: trimmed, ...videoStartRequest(options) },
  };
}

/** Toast after a stream/queue request, for one video or a playlist. */
export function queuedVideoToast(
  res: Pick<QueueVideoResponse, 'queued' | 'started' | 'playlistTitle' | 'truncated'>,
): string {
  if (res.queued === 1 && !res.playlistTitle) {
    return res.started ? 'Video stream started' : 'Added to Up next';
  }
  const count = `Queued ${res.queued} ${res.queued === 1 ? 'video' : 'videos'}`;
  const from = res.playlistTitle ? ` from ${res.playlistTitle}` : '';
  return `${count}${from}${res.truncated ? ` (first ${res.queued})` : ''}`;
}
