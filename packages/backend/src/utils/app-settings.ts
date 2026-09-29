import type { PrismaClient } from '../../generated/prisma/index.js';
import type { VideoStreamPresetKey, VideoStreamSettings } from '@ts6/common';
import { DEFAULT_AUTO_MAX_PRESET, isPresetKey } from '../voice/streaming/types.js';
import { isEncoderId, normalizeEncoderRequest } from '../voice/streaming/encoders.js';

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

export async function loadMaxPlaylistImport(prisma: PrismaClient): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: MAX_PLAYLIST_IMPORT_KEY } });
  return parseImportCap(row?.value);
}

// === Video streaming defaults (1.9.0) ===

export const VIDEO_NO_VIEWER_TIMEOUT_KEY = 'video_no_viewer_timeout';
export const VIDEO_AUTO_MAX_PRESET_KEY = 'video_auto_max_preset';
export const VIDEO_DEFAULT_ENCODER_KEY = 'video_default_encoder';
export const VIDEO_PREFER_HARDWARE_KEY = 'video_prefer_hardware';
export const VIDEO_MAX_BITRATE_KEY = 'video_max_bitrate_kbps';

export const VIDEO_STREAMING_SETTING_KEYS = [
  VIDEO_NO_VIEWER_TIMEOUT_KEY,
  VIDEO_AUTO_MAX_PRESET_KEY,
  VIDEO_DEFAULT_ENCODER_KEY,
  VIDEO_PREFER_HARDWARE_KEY,
  VIDEO_MAX_BITRATE_KEY,
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
 * VIDEO_PREFER_HARDWARE, VIDEO_MAX_BITRATE_KBPS.
 */
export function videoStreamingDefaults(env: NodeJS.ProcessEnv = process.env): VideoStreamSettings {
  const autoMax = env.VIDEO_AUTO_MAX_PRESET;
  return {
    noViewerTimeoutSec: parseBoundedInt(env.VIDEO_NO_VIEWER_TIMEOUT_SECONDS, MAX_NO_VIEWER_TIMEOUT_SEC) ?? 300,
    autoMaxPreset: isPresetKey(autoMax) ? autoMax : DEFAULT_AUTO_MAX_PRESET,
    defaultEncoder: normalizeEncoderRequest(env.VIDEO_ENCODER, 'auto'),
    preferHardware: parseBool(env.VIDEO_PREFER_HARDWARE) ?? false,
    maxBitrateKbps: parseBoundedInt(env.VIDEO_MAX_BITRATE_KBPS, MAX_BITRATE_CLAMP_KBPS) ?? 0,
  };
}

/** Merge stored admin values over env defaults; invalid stored values are ignored. */
export function parseVideoStreamingSettings(
  stored: Map<string, string>,
  defaults: VideoStreamSettings = videoStreamingDefaults(),
): VideoStreamSettings {
  const autoMax = stored.get(VIDEO_AUTO_MAX_PRESET_KEY);
  return {
    noViewerTimeoutSec:
      parseBoundedInt(stored.get(VIDEO_NO_VIEWER_TIMEOUT_KEY), MAX_NO_VIEWER_TIMEOUT_SEC) ?? defaults.noViewerTimeoutSec,
    autoMaxPreset: isPresetKey(autoMax) ? (autoMax as VideoStreamPresetKey) : defaults.autoMaxPreset,
    defaultEncoder: normalizeEncoderRequest(stored.get(VIDEO_DEFAULT_ENCODER_KEY), defaults.defaultEncoder),
    preferHardware: parseBool(stored.get(VIDEO_PREFER_HARDWARE_KEY)) ?? defaults.preferHardware,
    maxBitrateKbps: parseBoundedInt(stored.get(VIDEO_MAX_BITRATE_KEY), MAX_BITRATE_CLAMP_KBPS) ?? defaults.maxBitrateKbps,
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
  const out: Partial<VideoStreamSettings> = {};
  for (const field of ['noViewerTimeoutSec', 'autoMaxPreset', 'defaultEncoder', 'preferHardware', 'maxBitrateKbps'] as const) {
    const value = (obj as Record<string, unknown>)[field];
    if (value === undefined) continue;
    const check = parseVideoStreamingUpdate({ [field]: value });
    if (!check.ok) continue;
    // Store normalized types (numbers/bools), not raw input strings like "60".
    const raw = check.rows[0].value;
    (out as Record<string, unknown>)[field] =
      field === 'noViewerTimeoutSec' || field === 'maxBitrateKbps' ? Number(raw)
        : field === 'preferHardware' ? raw === 'true'
          : raw;
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

  if (b.noViewerTimeoutSec !== undefined) {
    const n = parseBoundedInt(b.noViewerTimeoutSec, MAX_NO_VIEWER_TIMEOUT_SEC);
    if (n == null) return { ok: false, error: `noViewerTimeoutSec must be 0–${MAX_NO_VIEWER_TIMEOUT_SEC} seconds (0 = off)` };
    rows.push({ key: VIDEO_NO_VIEWER_TIMEOUT_KEY, value: String(n) });
  }
  if (b.autoMaxPreset !== undefined) {
    if (!isPresetKey(b.autoMaxPreset)) return { ok: false, error: 'autoMaxPreset must be 480p, 720p, 1080p, 1440p or 2160p' };
    rows.push({ key: VIDEO_AUTO_MAX_PRESET_KEY, value: b.autoMaxPreset });
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
  }

  if (rows.length === 0) return { ok: false, error: 'No video streaming settings supplied' };
  return { ok: true, rows };
}
