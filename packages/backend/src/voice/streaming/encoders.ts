/**
 * Encoder selection. The sidecar owns capability probing and hardware→software
 * fallback; the backend only resolves `auto` and knows each encoder's codec so
 * viewers negotiate the codec ffmpeg will actually send.
 */

import {
  VIDEO_ENCODER_IDS,
  type VideoCodec,
  type VideoEncoderCapabilities,
  type VideoEncoderId,
  type VideoEncoderRequest,
} from '@ts6/common';

export const ENCODER_CODEC: Record<VideoEncoderId, VideoCodec> = {
  vp8: 'vp8',
  vp9: 'vp9',
  h264: 'h264',
  vp8_vaapi: 'vp8',
  vp9_vaapi: 'vp9',
  h264_vaapi: 'h264',
  h264_nvenc: 'h264',
  h264_amf: 'h264',
};

/**
 * Hardware preference order for `auto`: H.264 (Constrained High) has the widest
 * VAAPI encode support, and is the supported codec for NVENC and AMF; VP8 VAAPI
 * exists only on some older Intel generations. A host normally has one backend,
 * so the order between backends only matters where several pass their probes.
 */
export const AUTO_HARDWARE_ORDER: readonly VideoEncoderId[] = ['h264_vaapi', 'h264_nvenc', 'h264_amf', 'vp9_vaapi', 'vp8_vaapi'];

export function isEncoderId(value: unknown): value is VideoEncoderId {
  return typeof value === 'string' && (VIDEO_ENCODER_IDS as readonly string[]).includes(value);
}

export function isHardwareEncoder(id: VideoEncoderId): boolean {
  return id.endsWith('_vaapi') || id.endsWith('_nvenc') || id.endsWith('_amf');
}

export function normalizeEncoderRequest(value: unknown, fallback: VideoEncoderRequest): VideoEncoderRequest {
  if (value === 'auto' || isEncoderId(value)) return value;
  return fallback;
}

export interface EncoderSelection {
  selected: VideoEncoderId;
  note: string | null;
}

/**
 * Resolve a request to a concrete encoder. Explicit IDs pass through (the
 * sidecar falls back and reports it). `auto` is software VP8 unless hardware is
 * preferred and the capability probe found a working hardware encoder.
 */
export function selectEncoder(
  requested: VideoEncoderRequest,
  preferHardware: boolean,
  caps: VideoEncoderCapabilities | null,
): EncoderSelection {
  if (requested !== 'auto') return { selected: requested, note: null };
  if (!preferHardware) return { selected: 'vp8', note: null };
  if (!caps) {
    return { selected: 'vp8', note: 'Encoder capabilities unavailable — using software VP8' };
  }
  for (const id of AUTO_HARDWARE_ORDER) {
    if (caps.encoders.some((e) => e.id === id && e.available)) {
      return { selected: id, note: null };
    }
  }
  return { selected: 'vp8', note: 'Hardware preferred but no working hardware encoder passed the test encode — using software VP8' };
}

const ENCODER_NAMES: Record<VideoEncoderId, string> = {
  vp8: 'VP8 (software)',
  vp9: 'VP9 (software)',
  h264: 'H.264 (software)',
  vp8_vaapi: 'VP8 (VAAPI)',
  vp9_vaapi: 'VP9 (VAAPI)',
  h264_vaapi: 'H.264 (VAAPI)',
  h264_nvenc: 'H.264 (NVENC)',
  h264_amf: 'H.264 (AMF)',
};

export function encoderDisplayName(id: VideoEncoderId): string {
  return ENCODER_NAMES[id] ?? id;
}
