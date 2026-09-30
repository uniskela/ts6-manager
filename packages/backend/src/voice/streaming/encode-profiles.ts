/**
 * Performance / Balanced / Quality → Auto max, bitrate clamp, libvpx cpu-used.
 */

import type { VideoEncodeProfile, VideoStreamPresetKey, VideoStreamSettings } from '@ts6/common';

export type NamedEncodeProfile = Exclude<VideoEncodeProfile, 'custom'>;

export const ENCODE_PROFILE_PRESETS: Record<
  NamedEncodeProfile,
  { autoMaxPreset: VideoStreamPresetKey; maxBitrateKbps: number; cpuUsed: number }
> = {
  performance: { autoMaxPreset: '720p', maxBitrateKbps: 2500, cpuUsed: 6 },
  balanced: { autoMaxPreset: '1080p', maxBitrateKbps: 4500, cpuUsed: 4 },
  quality: { autoMaxPreset: '1440p', maxBitrateKbps: 0, cpuUsed: 2 },
};

export const DEFAULT_ENCODE_PROFILE: NamedEncodeProfile = 'balanced';

/** libvpx -cpu-used range (ffmpeg accepts 0–8 for realtime VP8). */
export const MIN_CPU_USED = 0;
export const MAX_CPU_USED = 8;

export function isNamedEncodeProfile(value: unknown): value is NamedEncodeProfile {
  return value === 'performance' || value === 'balanced' || value === 'quality';
}

export function isEncodeProfile(value: unknown): value is VideoEncodeProfile {
  return isNamedEncodeProfile(value) || value === 'custom';
}

export function applyEncodeProfile(profile: NamedEncodeProfile): Pick<
  VideoStreamSettings,
  'autoMaxPreset' | 'maxBitrateKbps' | 'cpuUsed' | 'encodeProfile'
> {
  const p = ENCODE_PROFILE_PRESETS[profile];
  return {
    autoMaxPreset: p.autoMaxPreset,
    maxBitrateKbps: p.maxBitrateKbps,
    cpuUsed: p.cpuUsed,
    encodeProfile: profile,
  };
}

/** Match stored Auto max + bitrate + cpuUsed to a named profile, else custom. */
export function inferEncodeProfile(parts: {
  autoMaxPreset: VideoStreamPresetKey;
  maxBitrateKbps: number;
  cpuUsed: number;
}): VideoEncodeProfile {
  for (const name of Object.keys(ENCODE_PROFILE_PRESETS) as NamedEncodeProfile[]) {
    const p = ENCODE_PROFILE_PRESETS[name];
    if (
      p.autoMaxPreset === parts.autoMaxPreset
      && p.maxBitrateKbps === parts.maxBitrateKbps
      && p.cpuUsed === parts.cpuUsed
    ) {
      return name;
    }
  }
  return 'custom';
}
