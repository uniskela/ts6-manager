/**
 * Shared encode profile constants for the video defaults UI.
 * Keep values aligned with packages/backend/src/voice/streaming/encode-profiles.ts.
 */

import type { VideoEncodeProfile, VideoStreamPresetKey, VideoStreamSettings } from '@ts6/common';

export type NamedEncodeProfile = Exclude<VideoEncodeProfile, 'custom'>;

export const ENCODE_PROFILE_PRESETS: Record<
  NamedEncodeProfile,
  { autoMaxPreset: VideoStreamPresetKey; maxBitrateKbps: number; cpuUsed: number; label: string; hint: string }
> = {
  performance: {
    autoMaxPreset: '720p', maxBitrateKbps: 2500, cpuUsed: 6,
    label: 'Performance', hint: '720p · 2.5 Mbps · faster encode',
  },
  balanced: {
    autoMaxPreset: '1080p', maxBitrateKbps: 4500, cpuUsed: 4,
    label: 'Balanced', hint: '1080p · 4.5 Mbps · default encode',
  },
  quality: {
    autoMaxPreset: '1440p', maxBitrateKbps: 0, cpuUsed: 2,
    label: 'Quality', hint: '1440p · no bitrate clamp · slower encode',
  },
};

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
