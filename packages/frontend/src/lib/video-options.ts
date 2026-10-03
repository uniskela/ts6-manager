/**
 * Per-start video choices in the bot console (Link and IPTV tabs). They start
 * on the server's streaming defaults and apply to one start only, so the
 * console never saves over the defaults.
 */

import type {
  StartVideoStreamRequest, VideoEncoderRequest, VideoQualityRequest, VideoSourceModeRequest, VideoStreamSettings,
} from '@ts6/common';
import {
  ENCODER_OPTIONS, NO_VIEWER_TIMEOUT_OPTIONS, QUALITY_OPTIONS, SOURCE_MODE_OPTIONS, formatTimeout,
} from './video-streaming';

export interface VideoStartOptions {
  quality: VideoQualityRequest;
  encoder: VideoEncoderRequest;
  /** Seconds as a string ("0" = off); "" only while the server setting is unknown. */
  noViewerTimeout: string;
  sourceMode: VideoSourceModeRequest;
}

/**
 * What the console's video options start on: Auto quality, and this server's
 * effective streaming defaults (env `VIDEO_ENCODER` /
 * `VIDEO_NO_VIEWER_TIMEOUT_SECONDS`, then Media Library → Streaming defaults).
 * Before those load, the encoder starts on Auto and the timeout is left to the server.
 */
export function videoStartDefaults(
  settings: Pick<VideoStreamSettings, 'defaultEncoder' | 'noViewerTimeoutSec'> | null | undefined,
  sourceMode: VideoSourceModeRequest = 'auto',
): VideoStartOptions {
  const encoder = typeof settings?.defaultEncoder === 'string' ? settings.defaultEncoder : 'auto';
  const timeout = typeof settings?.noViewerTimeoutSec === 'number' && Number.isFinite(settings.noViewerTimeoutSec)
    ? String(Math.max(0, Math.floor(settings.noViewerTimeoutSec)))
    : '';
  return { quality: 'auto', encoder, noViewerTimeout: timeout, sourceMode };
}

export const DEFAULT_VIDEO_START_OPTIONS: VideoStartOptions = videoStartDefaults(null);

export function videoStartRequest(
  options: VideoStartOptions,
): Pick<StartVideoStreamRequest, 'preset' | 'encoder' | 'noViewerTimeoutSec' | 'sourceMode'> {
  return {
    preset: options.quality,
    encoder: options.encoder,
    noViewerTimeoutSec: options.noViewerTimeout === '' ? undefined : Number(options.noViewerTimeout),
    sourceMode: options.sourceMode,
  };
}

/** "No auto-stop", "5 min", "15 min" for a no-viewer timeout in seconds. */
export function noViewerTimeoutLabel(value: string): string {
  if (value === '') return 'Server setting';
  return NO_VIEWER_TIMEOUT_OPTIONS.find((o) => o.value === value)?.label ?? formatTimeout(Number(value));
}

/** One line for the folded options row: "Auto · Auto encoder · stops after 5 min · Live". */
export function videoOptionsSummary(value: VideoStartOptions): string {
  const quality = QUALITY_OPTIONS.find((o) => o.value === value.quality)?.label ?? value.quality;
  const encoder = ENCODER_OPTIONS.find((o) => o.value === value.encoder)?.label ?? value.encoder;
  const parts = [quality, value.encoder === 'auto' ? 'Auto encoder' : encoder];
  if (value.noViewerTimeout !== '') {
    parts.push(value.noViewerTimeout === '0' ? 'no auto-stop' : `stops after ${noViewerTimeoutLabel(value.noViewerTimeout)}`);
  }
  parts.push(SOURCE_MODE_OPTIONS.find((o) => o.value === value.sourceMode)?.label ?? value.sourceMode);
  return parts.join(' · ');
}
