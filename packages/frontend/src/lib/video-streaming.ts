/**
 * Video streaming labels and formatting shared by the stream controls and IPTV.
 */

import type {
  VideoSourceMode,
  VideoSourceModeRequest,
  VideoStreamHealth,
  MediaStopInfo,
  MediaStopReason,
  VideoEncoderId,
  VideoEncoderRequest,
  VideoQualityRequest,
  VideoStreamEncoderInfo,
  VideoStreamPresetKey,
  VideoStreamQualityInfo,
} from '@ts6/common';

export const QUALITY_OPTIONS: ReadonlyArray<{ value: VideoQualityRequest; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'Match the source, never upscale' },
  { value: '480p', label: '480p', hint: '854×480 · 1 Mbps' },
  { value: '720p', label: '720p', hint: '1280×720 · 2.5 Mbps' },
  { value: '1080p', label: '1080p', hint: '1920×1080 · 4.5 Mbps' },
  { value: '1440p', label: '1440p', hint: '2560×1440 · 8 Mbps' },
  { value: '2160p', label: '2160p', hint: '3840×2160 · 14 Mbps' },
];

export const AUTO_LIMIT_OPTIONS: ReadonlyArray<VideoStreamPresetKey> = ['720p', '1080p', '1440p', '2160p'];

export const ENCODER_LABELS: Record<VideoEncoderId, string> = {
  vp8: 'VP8 (software)',
  vp9: 'VP9 (software)',
  h264: 'H.264 (software)',
  vp8_vaapi: 'VP8 (VAAPI)',
  vp9_vaapi: 'VP9 (VAAPI)',
  h264_vaapi: 'H.264 (VAAPI)',
  h264_nvenc: 'H.264 (NVENC)',
};

export const ENCODER_OPTIONS: ReadonlyArray<{ value: VideoEncoderRequest; label: string }> = [
  { value: 'auto', label: 'Auto' },
  ...(Object.keys(ENCODER_LABELS) as VideoEncoderId[]).map((id) => ({ value: id, label: ENCODER_LABELS[id] })),
];

/** Per-stream no-viewer timeout choices; `default` uses the admin setting. */
export const NO_VIEWER_TIMEOUT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: '0', label: 'Off' },
  { value: '60', label: '1 min' },
  { value: '300', label: '5 min' },
  { value: '600', label: '10 min' },
  { value: '1800', label: '30 min' },
];

export const STOP_REASON_LABELS: Record<MediaStopReason, string> = {
  manual: 'Stopped manually',
  no_viewers: 'No viewers',
  channel_empty: 'Channel empty',
  source_ended: 'Source ended',
  source_unreachable: 'Source unreachable',
  encoder_failure: 'Encoder failure',
  sidecar_failure: 'Media sidecar stopped',
  replaced_by_music: 'Replaced by music',
  replaced_by_video: 'Replaced by another stream',
  server_disconnect: 'Server disconnected',
  bot_stopped: 'Bot stopped',
};

/** "4:59" / "1:02:03" for a countdown or uptime in milliseconds. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** "Off", "5 min", "90 s", "1 h 30 min". */
export function formatTimeout(sec: number): string {
  if (sec <= 0) return 'Off';
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s) parts.push(`${s} s`);
  return parts.join(' ');
}

/** "Auto → 1080p", or just "1440p" for a fixed preset. */
export function qualityLabel(q: VideoStreamQualityInfo | null | undefined, fallbackPreset?: string): string {
  if (!q) return fallbackPreset ?? '—';
  return q.requested === 'auto' ? `Auto → ${q.actual}` : q.actual;
}

/** "H.264 (VAAPI)", "Auto → VP8 (software)", or "H.264 (VAAPI) → H.264 (software)" after a fallback. */
export function encoderLabel(e: VideoStreamEncoderInfo | null | undefined): string {
  if (!e) return '—';
  const active = ENCODER_LABELS[e.active] ?? e.active;
  if (e.selected !== e.active) return `${ENCODER_LABELS[e.selected] ?? e.selected} → ${active}`;
  if (e.requested === 'auto') return `Auto → ${active}`;
  return active;
}

/** "No viewers — Stopped after 5 minutes with no viewers · 8 min ago". */
export function lastStopLabel(stop: MediaStopInfo | null | undefined, now: number = Date.now()): string | null {
  if (!stop) return null;
  const base = stop.detail || STOP_REASON_LABELS[stop.reason] || stop.reason;
  const agoMin = Math.floor(Math.max(0, now - stop.at) / 60_000);
  const ago = agoMin < 1 ? 'just now' : agoMin < 60 ? `${agoMin} min ago` : `${Math.floor(agoMin / 60)} h ago`;
  return `${base} · ${ago}`;
}

export const SOURCE_MODE_OPTIONS: ReadonlyArray<{ value: VideoSourceModeRequest; label: string }> = [
  { value: 'auto', label: 'Detect' },
  { value: 'live', label: 'Live' },
  { value: 'vod', label: 'On demand' },
];

export const SOURCE_MODE_LABELS: Record<VideoSourceMode, string> = {
  live: 'Live',
  vod: 'On demand',
  file: 'Local file',
};

/** "1.01x · 30 fps" or "—" before the first sample. */
export function healthLabel(h: VideoStreamHealth | null | undefined): string {
  if (!h || h.speed == null) return '—';
  const fps = h.fps != null ? ` · ${Math.round(h.fps)} fps` : '';
  return `${h.speed.toFixed(2)}x${fps}`;
}
