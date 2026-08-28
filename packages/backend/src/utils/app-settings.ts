import type { PrismaClient } from '../../generated/prisma/index.js';

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
