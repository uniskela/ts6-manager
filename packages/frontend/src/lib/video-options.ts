/**
 * Per-start video choices in the bot console (Link and IPTV tabs). "default"
 * leaves the choice to the server's streaming defaults, which the backend
 * applies, so the console never saves over them.
 */

import type {
  StartVideoStreamRequest, VideoEncoderRequest, VideoQualityRequest, VideoSourceModeRequest,
} from '@ts6/common';

export interface VideoStartOptions {
  /** "default" uses the bot's own quality setting; "auto" overrides it. */
  quality: VideoQualityRequest | 'default';
  encoder: VideoEncoderRequest | 'default';
  /** "default", "0" (off) or a number of seconds. */
  noViewerTimeout: string;
  sourceMode: VideoSourceModeRequest;
}

export const DEFAULT_VIDEO_START_OPTIONS: VideoStartOptions = {
  quality: 'default', encoder: 'default', noViewerTimeout: 'default', sourceMode: 'auto',
};

export function videoStartRequest(
  options: VideoStartOptions,
): Pick<StartVideoStreamRequest, 'preset' | 'encoder' | 'noViewerTimeoutSec' | 'sourceMode'> {
  return {
    preset: options.quality === 'default' ? undefined : options.quality,
    encoder: options.encoder === 'default' ? undefined : options.encoder,
    noViewerTimeoutSec: options.noViewerTimeout === 'default' ? undefined : Number(options.noViewerTimeout),
    sourceMode: options.sourceMode,
  };
}
