import type { QueueItem } from './playlist/queue.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { resolvePathUnderMusicDir } from './streaming/video-download.js';
import { validateUrl } from '../utils/url-validator.js';
import { AppError } from '../middleware/error-handler.js';

/** Newest rows kept for one bot on one connection. */
const configuredLimit = Number(process.env.MUSIC_REQUEST_HISTORY_LIMIT);
export const MUSIC_REQUEST_HISTORY_LIMIT = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
  ? Math.min(configuredLimit, 1000) : 100;

export const MEDIA_UNAVAILABLE = 'This media is no longer available.';

/** Prisma diagnostics without messages, metadata, URLs or paths. */
export function musicHistoryErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && code.length === 5 && /^P\d{4}$/.test(code) ? code : 'UNKNOWN';
}

export interface MusicRequestReference {
  url: string;
  source: string;
}

type HistoryRow = {
  id: number;
  requestedAt: Date;
};

export interface MusicRequestHistoryDb {
  musicRequest: {
    upsert(args: any): Promise<unknown>;
    findMany(args: any): Promise<HistoryRow[]>;
    deleteMany(args: any): Promise<unknown>;
    update(args: any): Promise<unknown>;
  };
}

export type ReplayReference =
  | { ok: true; kind: 'url'; url: string }
  | { ok: true; kind: 'radio'; url: string }
  | { ok: true; kind: 'local'; filePath: string }
  | { ok: false; error: string };

/** Stored source URL, stream URL, or local file. Titles are not references. */
export function canonicalRequestReference(item: Pick<QueueItem, 'source' | 'sourceUrl' | 'streamUrl' | 'filePath'>): MusicRequestReference | null {
  const source = item.source || 'url';
  const url = (item.sourceUrl || item.streamUrl || (source === 'local' ? item.filePath : '') || '').trim();
  if (!url) return null;
  return { url, source };
}

export function musicRequestListWhere(serverConfigId: number, musicBotId?: number) {
  if (!musicBotId) return { serverConfigId };
  return { serverConfigId, OR: [{ musicBotId }, { musicBotId: 0 }] };
}

export const PUBLIC_MUSIC_REQUEST_SELECT = {
  id: true,
  title: true,
  artist: true,
  duration: true,
  source: true,
  status: true,
  requestedAt: true,
} as const;

export async function recordMusicRequest(
  db: MusicRequestHistoryDb,
  input: { serverConfigId: number; musicBotId: number; title: string; url: string; source: string; artist?: string; duration?: number },
  limit = MUSIC_REQUEST_HISTORY_LIMIT,
): Promise<void> {
  await db.musicRequest.upsert(requestUpsert(input, new Date()));
  await pruneMusicRequests(db, input.serverConfigId, input.musicBotId, limit);
}

function requestUpsert(
  input: { serverConfigId: number; musicBotId: number; title: string; url: string; source: string; artist?: string; duration?: number },
  requestedAt: Date,
) {
  const title = input.title || 'Unknown Title';
  return {
    where: {
      serverConfigId_musicBotId_url: {
        serverConfigId: input.serverConfigId,
        musicBotId: input.musicBotId,
        url: input.url,
      },
    },
    update: { requestedAt, title, source: input.source, status: 'available', artist: input.artist, duration: input.duration },
    create: {
      serverConfigId: input.serverConfigId,
      musicBotId: input.musicBotId,
      url: input.url,
      title,
      artist: input.artist,
      duration: input.duration,
      source: input.source,
      status: 'available',
      requestedAt,
    },
  };
}

/** A playlist shares one write transaction and one retention pass. */
export async function recordMusicRequests(
  db: Pick<PrismaClient, '$transaction'>,
  scope: { serverConfigId: number; musicBotId: number },
  items: QueueItem[],
  limit = MUSIC_REQUEST_HISTORY_LIMIT,
): Promise<void> {
  const requestedAt = new Date();
  const writes = items.flatMap(item => {
    const ref = canonicalRequestReference(item);
    return ref ? [requestUpsert({ ...scope, ...ref, title: item.title, artist: item.artist, duration: item.duration }, requestedAt)] : [];
  });
  if (!writes.length) return;
  await db.$transaction(async tx => {
    await Promise.all(writes.map(args => tx.musicRequest.upsert(args)));
    await pruneMusicRequests(tx, scope.serverConfigId, scope.musicBotId, limit);
  });
}

/** Legacy rows have no bot; remove only scoped history of bots that no longer exist. */
export async function pruneOrphanMusicRequests(db: Pick<PrismaClient, '$executeRaw'>, serverConfigId: number): Promise<void> {
  await db.$executeRaw`DELETE FROM "MusicRequest"
    WHERE "serverConfigId" = ${serverConfigId} AND "musicBotId" > 0
    AND NOT EXISTS (SELECT 1 FROM "MusicBot"
      WHERE "MusicBot"."id" = "MusicRequest"."musicBotId"
        AND "MusicBot"."serverConfigId" = "MusicRequest"."serverConfigId")`;
}

export async function pruneMusicRequests(
  db: MusicRequestHistoryDb,
  serverConfigId: number,
  musicBotId: number,
  limit = MUSIC_REQUEST_HISTORY_LIMIT,
): Promise<void> {
  const stale = await db.musicRequest.findMany({
    where: { serverConfigId, musicBotId },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    skip: limit,
    select: { id: true, requestedAt: true },
  });
  if (stale.length === 0) return;
  // A concurrent replay can refresh a row after the stale list was read.
  await db.musicRequest.deleteMany({ where: {
    id: { in: stale.map((row) => row.id) }, requestedAt: { lte: stale[0].requestedAt },
  } });
}

export function markMusicRequestUnavailable(db: MusicRequestHistoryDb, id: number): Promise<unknown> {
  return db.musicRequest.update({ where: { id }, data: { status: 'unavailable' } });
}

export function isUnavailableMusicRequestError(error: unknown): boolean {
  if (!(error instanceof Error) || /^(?:yt-dlp|ffmpeg|ffprobe) not found/i.test(error.message) || /ENOENT/i.test(error.message)) return false;
  return /(?:video|media|track|song|file|source).*(?:unavailable|removed|deleted|not found)/i.test(error.message)
    || /(?:unavailable|removed|deleted) (?:video|media|track|song)/i.test(error.message)
    || /HTTP (?:Error )?(?:404|410)|private video/i.test(error.message);
}

export async function replayReference(
  row: { url: string; source: string },
  deps: {
    validateUrl?: (url: string) => Promise<{ valid: boolean; error?: string }>;
    resolveLocal?: (filePath: string) => string;
  } = {},
): Promise<ReplayReference> {
  const validate = deps.validateUrl ?? validateUrl;
  const resolveLocal = deps.resolveLocal ?? resolvePathUnderMusicDir;
  if (row.source === 'local') {
    try {
      return { ok: true, kind: 'local', filePath: resolveLocal(row.url) };
    } catch {
      return { ok: false, error: MEDIA_UNAVAILABLE };
    }
  }
  if (!/^https?:\/\//i.test(row.url)) return { ok: false, error: MEDIA_UNAVAILABLE };
  const validation = await validate(row.url);
  if (!validation.valid) {
    if (validation.error?.endsWith('could not be resolved')) {
      throw new AppError(503, 'Media source could not be resolved. Try again.', undefined, { retryable: true });
    }
    return { ok: false, error: MEDIA_UNAVAILABLE };
  }
  if (row.source === 'radio') return { ok: true, kind: 'radio', url: row.url };
  return { ok: true, kind: 'url', url: row.url };
}
