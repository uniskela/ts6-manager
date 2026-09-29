/**
 * Video streaming types and quality presets
 */

import type {
  VideoStreamPreset,
  VideoStreamPresetKey,
  VideoViewerInfo,
  VideoStreamStatus,
} from '@ts6/common';

export type { VideoStreamPreset, VideoStreamPresetKey, VideoViewerInfo, VideoStreamStatus };

export const STREAM_PRESETS: Record<VideoStreamPresetKey, VideoStreamPreset> = {
  '480p': { label: '480p', width: 854, height: 480, bitrate: '1000k', framerate: 24 },
  '720p': { label: '720p', width: 1280, height: 720, bitrate: '2500k', framerate: 30 },
  '1080p': { label: '1080p', width: 1920, height: 1080, bitrate: '4500k', framerate: 30 },
  '1440p': { label: '1440p', width: 2560, height: 1440, bitrate: '8000k', framerate: 30 },
  '2160p': { label: '2160p', width: 3840, height: 2160, bitrate: '9500k', framerate: 30 },
};

/** Presets from smallest to largest. */
export const PRESET_ORDER: readonly VideoStreamPresetKey[] = ['480p', '720p', '1080p', '1440p', '2160p'];

export const DEFAULT_PRESET: VideoStreamPresetKey = '720p';
export const DEFAULT_AUTO_MAX_PRESET: VideoStreamPresetKey = '1080p';

export function isPresetKey(value: unknown): value is VideoStreamPresetKey {
  return typeof value === 'string' && (PRESET_ORDER as readonly string[]).includes(value);
}
