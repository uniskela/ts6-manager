/**
 * Stream quality selection: fixed presets, Auto (largest preset the source
 * fills, capped by the Auto limit) and the admin bitrate clamp.
 */

import type { VideoQualityRequest, VideoStreamPresetKey, VideoStreamQualityInfo } from '@ts6/common';
import { DEFAULT_PRESET, PRESET_ORDER, STREAM_PRESETS, isPresetKey } from './types.js';

/**
 * The sidecar scales the source to fit inside the preset frame (keeping aspect
 * ratio). A preset is usable when that fit does not upscale the content by more
 * than ~11%, so letterboxed (2.39:1), portrait and slightly short (1916x1076)
 * sources still get their natural preset, but a 720p source never becomes 1080p.
 */
const MAX_UPSCALE = 1 / 0.9;

export function presetFitsWithoutUpscale(key: VideoStreamPresetKey, width: number, height: number): boolean {
  const p = STREAM_PRESETS[key];
  if (width <= 0 || height <= 0) return false;
  return Math.min(p.width / width, p.height / height) <= MAX_UPSCALE;
}

/** Largest preset ≤ limit that needs no upscaling; the smallest preset when every one would. */
export function selectAutoPreset(
  width: number,
  height: number,
  limit: VideoStreamPresetKey,
): VideoStreamPresetKey {
  const allowed = PRESET_ORDER.slice(0, PRESET_ORDER.indexOf(limit) + 1);
  let chosen: VideoStreamPresetKey = allowed[0];
  for (const key of allowed) {
    if (presetFitsWithoutUpscale(key, width, height)) chosen = key;
  }
  return chosen;
}

export function normalizeQualityRequest(value: unknown, fallback: VideoQualityRequest): VideoQualityRequest {
  if (value === 'auto' || isPresetKey(value)) return value;
  return fallback;
}

export function capPreset(key: VideoStreamPresetKey, limit: VideoStreamPresetKey): VideoStreamPresetKey {
  return PRESET_ORDER.indexOf(key) > PRESET_ORDER.indexOf(limit) ? limit : key;
}

export interface SourceResolution {
  width: number;
  height: number;
}

/**
 * Resolve requested quality to an actual preset. Fixed presets never probe;
 * Auto uses the probed resolution and falls back to the default (capped) preset
 * with a note when the probe failed.
 */
export function resolveQuality(
  requested: VideoQualityRequest,
  autoLimit: VideoStreamPresetKey,
  probed: SourceResolution | null,
): VideoStreamQualityInfo {
  if (requested !== 'auto') {
    const p = STREAM_PRESETS[requested];
    return {
      requested,
      actual: requested,
      width: p.width,
      height: p.height,
      sourceWidth: null,
      sourceHeight: null,
      note: null,
    };
  }

  if (!probed) {
    const actual = capPreset(DEFAULT_PRESET, autoLimit);
    const p = STREAM_PRESETS[actual];
    return {
      requested,
      actual,
      width: p.width,
      height: p.height,
      sourceWidth: null,
      sourceHeight: null,
      note: `Source resolution unknown — using ${actual}`,
    };
  }

  const actual = selectAutoPreset(probed.width, probed.height, autoLimit);
  const p = STREAM_PRESETS[actual];
  const uncapped = selectAutoPreset(probed.width, probed.height, PRESET_ORDER[PRESET_ORDER.length - 1]);
  return {
    requested,
    actual,
    width: p.width,
    height: p.height,
    sourceWidth: probed.width,
    sourceHeight: probed.height,
    note: uncapped !== actual ? `Capped by Auto limit (${autoLimit})` : null,
  };
}

/** Parse "4500k" / "4500K" / "4500" (kbps) or "4.5M". Returns null when unparseable. */
export function parseBitrateKbps(value: string | null | undefined): number | null {
  const raw = String(value ?? '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(m[2].toLowerCase() === 'm' ? n * 1000 : n);
}

/**
 * Effective bitrate: the request (when valid) or the preset's bitrate, then
 * clamped to maxKbps when set.
 */
export function effectiveBitrate(
  requested: string | null | undefined,
  presetBitrate: string,
  maxKbps: number,
): string {
  const kbps = parseBitrateKbps(requested) ?? parseBitrateKbps(presetBitrate) ?? 2500;
  const clamped = maxKbps > 0 ? Math.min(kbps, maxKbps) : kbps;
  return `${clamped}k`;
}
