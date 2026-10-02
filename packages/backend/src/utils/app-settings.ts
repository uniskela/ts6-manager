import { parseLocalHostAllowlist } from './url-validator.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { VideoEncodeProfile, VideoStreamPresetKey, VideoStreamSettings } from '@ts6/common';
import { DEFAULT_AUTO_MAX_PRESET, isPresetKey } from '../voice/streaming/types.js';
import { isEncoderId, normalizeEncoderRequest } from '../voice/streaming/encoders.js';
import {
  DEFAULT_ENCODE_PROFILE,
  ENCODE_PROFILE_PRESETS,
  MAX_CPU_USED,
  MIN_CPU_USED,
  applyEncodeProfile,
  inferEncodeProfile,
  isEncodeProfile,
  isNamedEncodeProfile,
} from '../voice/streaming/encode-profiles.js';

export const MAX_VIDEO_DURATION_KEY = 'max_video_duration';
export const MAX_PLAYLIST_IMPORT_KEY = 'max_playlist_import';

export function parseVideoDuration(raw: string | null | undefined, fallback = 900): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function parseImportCap(raw: string | null | undefined, fallback = 250): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 500);
}

export async function loadMaxVideoDuration(prisma: PrismaClient): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: MAX_VIDEO_DURATION_KEY } });
  return parseVideoDuration(row?.value);
}

/** YouTube videos are streamed directly instead of downloaded first ('true' / 'false'). */
export const YOUTUBE_DIRECT_STREAM_KEY = 'youtube_direct_stream';

export async function loadYoutubeDirectStream(prisma: PrismaClient): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: YOUTUBE_DIRECT_STREAM_KEY } });
  return row?.value === 'true';
}

export async function loadMaxPlaylistImport(prisma: PrismaClient): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: MAX_PLAYLIST_IMPORT_KEY } });
  return parseImportCap(row?.value);
}

// === Video streaming defaults (1.9.0) ===

export const VIDEO_NO_VIEWER_TIMEOUT_KEY = 'video_no_viewer_timeout';
export const VIDEO_ANNOUNCE_AUTO_STOPS_KEY = 'video_announce_auto_stops';
export const VIDEO_AUTO_MAX_PRESET_KEY = 'video_auto_max_preset';
export const VIDEO_DEFAULT_ENCODER_KEY = 'video_default_encoder';
export const VIDEO_PREFER_HARDWARE_KEY = 'video_prefer_hardware';
export const VIDEO_MAX_BITRATE_KEY = 'video_max_bitrate_kbps';
export const VIDEO_ENCODE_PROFILE_KEY = 'video_encode_profile';
export const VIDEO_CPU_USED_KEY = 'video_cpu_used';

export const VIDEO_STREAMING_SETTING_KEYS = [
  VIDEO_NO_VIEWER_TIMEOUT_KEY,
  VIDEO_ANNOUNCE_AUTO_STOPS_KEY,
  VIDEO_AUTO_MAX_PRESET_KEY,
  VIDEO_DEFAULT_ENCODER_KEY,
  VIDEO_PREFER_HARDWARE_KEY,
  VIDEO_MAX_BITRATE_KEY,
  VIDEO_ENCODE_PROFILE_KEY,
  VIDEO_CPU_USED_KEY,
] as const;

/** Longest accepted no-viewer timeout (24 h). */
export const MAX_NO_VIEWER_TIMEOUT_SEC = 86_400;
/** Highest accepted bitrate clamp (100 Mbps). */
export const MAX_BITRATE_CLAMP_KBPS = 100_000;

/** Parse a non-negative integer within [0, max]; null when invalid. */
export function parseBoundedInt(raw: unknown, max: number): number | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n <= max ? n : null;
}

function parseBool(raw: string | undefined): boolean | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return null;
}

/**
 * Environment defaults, used when no admin value is stored:
 * VIDEO_NO_VIEWER_TIMEOUT_SECONDS, VIDEO_AUTO_MAX_PRESET, VIDEO_ENCODER,
 * VIDEO_PREFER_HARDWARE, VIDEO_MAX_BITRATE_KBPS, VIDEO_ENCODE_PROFILE, VIDEO_CPU_USED.
 * When encode knobs are unset, Balanced profile values apply.
 */
export function videoStreamingDefaults(env: NodeJS.ProcessEnv = process.env): VideoStreamSettings {
  const balanced = ENCODE_PROFILE_PRESETS[DEFAULT_ENCODE_PROFILE];
  const autoMax = env.VIDEO_AUTO_MAX_PRESET;
  const profileRaw = env.VIDEO_ENCODE_PROFILE;
  const namedFromEnv = isNamedEncodeProfile(profileRaw) ? profileRaw : null;
  const fromNamed = namedFromEnv ? applyEncodeProfile(namedFromEnv) : null;
  const cpuUsed =
    parseBoundedInt(env.VIDEO_CPU_USED, MAX_CPU_USED) ?? fromNamed?.cpuUsed ?? balanced.cpuUsed;
  const maxBitrateKbps =
    parseBoundedInt(env.VIDEO_MAX_BITRATE_KBPS, MAX_BITRATE_CLAMP_KBPS)
    ?? fromNamed?.maxBitrateKbps
    ?? balanced.maxBitrateKbps;
  const autoMaxPreset: VideoStreamPresetKey = isPresetKey(autoMax)
    ? autoMax
    : (fromNamed?.autoMaxPreset ?? (isPresetKey(DEFAULT_AUTO_MAX_PRESET) ? DEFAULT_AUTO_MAX_PRESET : balanced.autoMaxPreset));
  const encodeProfile: VideoEncodeProfile = isEncodeProfile(profileRaw)
    ? profileRaw
    : inferEncodeProfile({ autoMaxPreset, maxBitrateKbps, cpuUsed });
  return {
    noViewerTimeoutSec: parseBoundedInt(env.VIDEO_NO_VIEWER_TIMEOUT_SECONDS, MAX_NO_VIEWER_TIMEOUT_SEC) ?? 300,
    announceAutoStops: true,
    autoMaxPreset,
    defaultEncoder: normalizeEncoderRequest(env.VIDEO_ENCODER, 'auto'),
    preferHardware: parseBool(env.VIDEO_PREFER_HARDWARE) ?? false,
    maxBitrateKbps,
    encodeProfile,
    cpuUsed: Math.max(MIN_CPU_USED, cpuUsed),
  };
}

/** Merge stored admin values over env defaults; invalid stored values are ignored. */
export function parseVideoStreamingSettings(
  stored: Map<string, string>,
  defaults: VideoStreamSettings = videoStreamingDefaults(),
): VideoStreamSettings {
  const autoMax = stored.get(VIDEO_AUTO_MAX_PRESET_KEY);
  const autoMaxPreset = isPresetKey(autoMax) ? (autoMax as VideoStreamPresetKey) : defaults.autoMaxPreset;
  const maxBitrateKbps =
    parseBoundedInt(stored.get(VIDEO_MAX_BITRATE_KEY), MAX_BITRATE_CLAMP_KBPS) ?? defaults.maxBitrateKbps;
  const cpuUsed =
    parseBoundedInt(stored.get(VIDEO_CPU_USED_KEY), MAX_CPU_USED) ?? defaults.cpuUsed;
  const inferred = inferEncodeProfile({ autoMaxPreset, maxBitrateKbps, cpuUsed });
  const storedProfile = stored.get(VIDEO_ENCODE_PROFILE_KEY);
  let encodeProfile: VideoEncodeProfile = inferred;
  if (storedProfile === 'custom') encodeProfile = 'custom';
  else if (isNamedEncodeProfile(storedProfile)) {
    encodeProfile = inferred === storedProfile ? storedProfile : inferred;
  }
  return {
    noViewerTimeoutSec:
      parseBoundedInt(stored.get(VIDEO_NO_VIEWER_TIMEOUT_KEY), MAX_NO_VIEWER_TIMEOUT_SEC) ?? defaults.noViewerTimeoutSec,
    announceAutoStops: parseBool(stored.get(VIDEO_ANNOUNCE_AUTO_STOPS_KEY)) ?? defaults.announceAutoStops,
    autoMaxPreset,
    defaultEncoder: normalizeEncoderRequest(stored.get(VIDEO_DEFAULT_ENCODER_KEY), defaults.defaultEncoder),
    preferHardware: parseBool(stored.get(VIDEO_PREFER_HARDWARE_KEY)) ?? defaults.preferHardware,
    maxBitrateKbps,
    encodeProfile,
    cpuUsed,
  };
}

/** App setting holding one server's overrides as JSON (same field names as VideoStreamSettings). */
export function videoServerOverridesKey(serverConfigId: number): string {
  return `video_streaming_server:${serverConfigId}`;
}

/** Validate stored/submitted overrides; invalid fields are dropped. */
export function parseServerOverrides(raw: unknown): Partial<VideoStreamSettings> {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object') return {};
  // Validate fields one-by-one (ignore profile side effects), then normalize together
  // so a complete named profile stays named instead of collapsing to custom.
  const accepted: Record<string, unknown> = {};
  for (const field of [
    'noViewerTimeoutSec', 'announceAutoStops', 'autoMaxPreset', 'defaultEncoder', 'preferHardware',
    'maxBitrateKbps', 'encodeProfile', 'cpuUsed',
  ] as const) {
    const value = (obj as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (!parseVideoStreamingUpdate({ [field]: value }).ok) continue;
    accepted[field] = value;
  }
  if (Object.keys(accepted).length === 0) return {};
  const check = parseVideoStreamingUpdate(accepted);
  if (!check.ok) return {};
  const out: Partial<VideoStreamSettings> = {};
  for (const row of check.rows) {
    if (row.key === VIDEO_NO_VIEWER_TIMEOUT_KEY) out.noViewerTimeoutSec = Number(row.value);
    else if (row.key === VIDEO_ANNOUNCE_AUTO_STOPS_KEY) out.announceAutoStops = row.value === 'true';
    else if (row.key === VIDEO_AUTO_MAX_PRESET_KEY) out.autoMaxPreset = row.value as VideoStreamPresetKey;
    else if (row.key === VIDEO_DEFAULT_ENCODER_KEY) {
      out.defaultEncoder = row.value as VideoStreamSettings['defaultEncoder'];
    } else if (row.key === VIDEO_PREFER_HARDWARE_KEY) out.preferHardware = row.value === 'true';
    else if (row.key === VIDEO_MAX_BITRATE_KEY) out.maxBitrateKbps = Number(row.value);
    else if (row.key === VIDEO_ENCODE_PROFILE_KEY) out.encodeProfile = row.value as VideoEncodeProfile;
    else if (row.key === VIDEO_CPU_USED_KEY) out.cpuUsed = Number(row.value);
  }
  return out;
}

export async function loadVideoStreamingSettings(
  prisma: PrismaClient,
  serverConfigId?: number,
): Promise<VideoStreamSettings> {
  const keys: string[] = [...VIDEO_STREAMING_SETTING_KEYS];
  if (serverConfigId != null) keys.push(videoServerOverridesKey(serverConfigId));
  const rows = await prisma.appSetting.findMany({ where: { key: { in: keys } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const global = parseVideoStreamingSettings(map);
  if (serverConfigId == null) return global;
  return { ...global, ...parseServerOverrides(map.get(videoServerOverridesKey(serverConfigId))) };
}

/** Global defaults, one server's overrides, and the merged result. */
export async function loadServerVideoStreamingSettings(prisma: PrismaClient, serverConfigId: number) {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [...VIDEO_STREAMING_SETTING_KEYS, videoServerOverridesKey(serverConfigId)] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const global = parseVideoStreamingSettings(map);
  const overrides = parseServerOverrides(map.get(videoServerOverridesKey(serverConfigId)));
  return { global, overrides, effective: { ...global, ...overrides } };
}

export type VideoStreamingUpdate =
  | { ok: true; rows: Array<{ key: string; value: string }> }
  | { ok: false; error: string };

/** Validate a PUT body into setting rows; only supplied fields are updated. */
export function parseVideoStreamingUpdate(body: Record<string, unknown> | null | undefined): VideoStreamingUpdate {
  const b = body ?? {};
  const rows: Array<{ key: string; value: string }> = [];

  // Named encode profile expands to Auto max + bitrate + cpu-used.
  if (b.encodeProfile !== undefined) {
    if (!isEncodeProfile(b.encodeProfile)) {
      return { ok: false, error: 'encodeProfile must be performance, balanced, quality or custom' };
    }
    if (isNamedEncodeProfile(b.encodeProfile)) {
      const applied = applyEncodeProfile(b.encodeProfile);
      rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: applied.encodeProfile });
      rows.push({ key: VIDEO_AUTO_MAX_PRESET_KEY, value: applied.autoMaxPreset });
      rows.push({ key: VIDEO_MAX_BITRATE_KEY, value: String(applied.maxBitrateKbps) });
      rows.push({ key: VIDEO_CPU_USED_KEY, value: String(applied.cpuUsed) });
    } else {
      rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: 'custom' });
    }
  }

  if (b.noViewerTimeoutSec !== undefined) {
    const n = parseBoundedInt(b.noViewerTimeoutSec, MAX_NO_VIEWER_TIMEOUT_SEC);
    if (n == null) return { ok: false, error: `noViewerTimeoutSec must be 0–${MAX_NO_VIEWER_TIMEOUT_SEC} seconds (0 = off)` };
    rows.push({ key: VIDEO_NO_VIEWER_TIMEOUT_KEY, value: String(n) });
  }
  if (b.announceAutoStops !== undefined) {
    if (typeof b.announceAutoStops !== 'boolean') return { ok: false, error: 'announceAutoStops must be a boolean' };
    rows.push({ key: VIDEO_ANNOUNCE_AUTO_STOPS_KEY, value: b.announceAutoStops ? 'true' : 'false' });
  }
  if (b.autoMaxPreset !== undefined) {
    if (!isPresetKey(b.autoMaxPreset)) return { ok: false, error: 'autoMaxPreset must be 480p, 720p, 1080p, 1440p or 2160p' };
    rows.push({ key: VIDEO_AUTO_MAX_PRESET_KEY, value: b.autoMaxPreset });
    if (b.encodeProfile === undefined) rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: 'custom' });
  }
  if (b.defaultEncoder !== undefined) {
    if (b.defaultEncoder !== 'auto' && !isEncoderId(b.defaultEncoder)) {
      return { ok: false, error: 'defaultEncoder must be auto or a known encoder id' };
    }
    rows.push({ key: VIDEO_DEFAULT_ENCODER_KEY, value: String(b.defaultEncoder) });
  }
  if (b.preferHardware !== undefined) {
    if (typeof b.preferHardware !== 'boolean') return { ok: false, error: 'preferHardware must be a boolean' };
    rows.push({ key: VIDEO_PREFER_HARDWARE_KEY, value: b.preferHardware ? 'true' : 'false' });
  }
  if (b.maxBitrateKbps !== undefined) {
    const n = parseBoundedInt(b.maxBitrateKbps, MAX_BITRATE_CLAMP_KBPS);
    if (n == null) return { ok: false, error: `maxBitrateKbps must be 0–${MAX_BITRATE_CLAMP_KBPS} (0 = no clamp)` };
    rows.push({ key: VIDEO_MAX_BITRATE_KEY, value: String(n) });
    if (b.encodeProfile === undefined) rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: 'custom' });
  }
  if (b.cpuUsed !== undefined) {
    const n = parseBoundedInt(b.cpuUsed, MAX_CPU_USED);
    if (n == null) return { ok: false, error: `cpuUsed must be ${MIN_CPU_USED}–${MAX_CPU_USED}` };
    rows.push({ key: VIDEO_CPU_USED_KEY, value: String(n) });
    if (b.encodeProfile === undefined) rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: 'custom' });
  }

  if (rows.length === 0) return { ok: false, error: 'No video streaming settings supplied' };
  // Last write wins per key when profile expand + field overlap.
  const byKey = new Map<string, string>();
  for (const row of rows) byKey.set(row.key, row.value);
  return { ok: true, rows: [...byKey.entries()].map(([key, value]) => ({ key, value })) };
}

// --- IPTV sources on the local network ---------------------------------------

export const IPTV_LOCAL_HOSTS_KEY = 'iptv_allowed_local_hosts';
export const MAX_IPTV_LOCAL_HOSTS = 32;

/**
 * Operator-approved LAN hosts for IPTV playlists and channels (IPs, CIDRs or
 * hostnames). Invalid stored entries are dropped rather than trusted.
 */
export async function loadIptvLocalHosts(prisma: PrismaClient): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: IPTV_LOCAL_HOSTS_KEY } });
  if (!row?.value) return [];
  try {
    const value: unknown = JSON.parse(row.value);
    if (!Array.isArray(value)) return [];
    const entries = value.filter((v): v is string => typeof v === 'string');
    const { invalid } = parseLocalHostAllowlist(entries);
    return entries.filter((e) => !invalid.includes(e)).slice(0, MAX_IPTV_LOCAL_HOSTS);
  } catch {
    return [];
  }
}

export type IptvLocalHostsUpdate = { ok: true; value: string[] } | { ok: false; error: string };

export function parseIptvLocalHostsUpdate(body: Record<string, unknown> | null | undefined): IptvLocalHostsUpdate {
  const raw = body?.allowedLocalHosts;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    return { ok: false, error: 'allowedLocalHosts must be a list of hosts' };
  }
  const entries = [...new Set((raw as string[]).map((v) => v.trim().toLowerCase()).filter(Boolean))];
  if (entries.length > MAX_IPTV_LOCAL_HOSTS) {
    return { ok: false, error: `At most ${MAX_IPTV_LOCAL_HOSTS} hosts` };
  }
  if (entries.some((e) => e.length > 255)) {
    return { ok: false, error: 'Host entries are limited to 255 characters' };
  }
  const { invalid } = parseLocalHostAllowlist(entries);
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Not allowed: ${invalid.join(', ')}. Use a LAN IP (192.168.1.20), a range (192.168.1.0/24) or a hostname; `
        + 'loopback, link-local and cloud metadata addresses stay blocked.',
    };
  }
  return { ok: true, value: entries };
}
