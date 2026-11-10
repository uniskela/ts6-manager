import {
  DEFAULT_PLAYLIST_VOTE_SETTINGS,
  type PlaylistVoteSettings,
} from '@ts6/common';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';

type AppSettingClient = PrismaClient | Prisma.TransactionClient;

const THRESHOLD_MIN = 1;
const THRESHOLD_MAX = 100;
const MAX_REQUEST_SIZE_MIN = 1;
const MAX_REQUEST_SIZE_MAX = 500;

export function playlistVoteSettingsKey(serverConfigId: number, virtualServerId: number): string {
  return `playlist_vote_settings:${serverConfigId}:${virtualServerId}`;
}

export function defaultPlaylistVoteSettings(): PlaylistVoteSettings {
  return { ...DEFAULT_PLAYLIST_VOTE_SETTINGS };
}

/** Exact-shape validation for admin updates and stored JSON. */
export function parsePlaylistVoteSettings(raw: unknown): PlaylistVoteSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 3 || keys.some((key) => !['enabled', 'thresholdPercent', 'maxRequestSize'].includes(key))) {
    return null;
  }
  if (typeof obj.enabled !== 'boolean') return null;
  if (typeof obj.thresholdPercent !== 'number' || !Number.isSafeInteger(obj.thresholdPercent)
    || obj.thresholdPercent < THRESHOLD_MIN || obj.thresholdPercent > THRESHOLD_MAX) {
    return null;
  }
  if (typeof obj.maxRequestSize !== 'number' || !Number.isSafeInteger(obj.maxRequestSize)
    || obj.maxRequestSize < MAX_REQUEST_SIZE_MIN || obj.maxRequestSize > MAX_REQUEST_SIZE_MAX) {
    return null;
  }
  return {
    enabled: obj.enabled,
    thresholdPercent: obj.thresholdPercent,
    maxRequestSize: obj.maxRequestSize,
  };
}

export async function loadPlaylistVoteSettings(
  prisma: AppSettingClient, serverConfigId: number, virtualServerId: number,
): Promise<PlaylistVoteSettings> {
  const row = await prisma.appSetting.findUnique({
    where: { key: playlistVoteSettingsKey(serverConfigId, virtualServerId) },
  });
  // A missing or corrupt row keeps voting off (upgrade-safe default).
  if (!row) return defaultPlaylistVoteSettings();
  try {
    const settings = parsePlaylistVoteSettings(JSON.parse(row.value));
    if (settings) return settings;
  } catch { /* fall through */ }
  return defaultPlaylistVoteSettings();
}

export async function savePlaylistVoteSettings(
  prisma: AppSettingClient,
  serverConfigId: number,
  virtualServerId: number,
  settings: PlaylistVoteSettings,
): Promise<PlaylistVoteSettings> {
  const key = playlistVoteSettingsKey(serverConfigId, virtualServerId);
  const value = JSON.stringify(settings);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return settings;
}
