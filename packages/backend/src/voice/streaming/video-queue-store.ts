import type { VideoSourceModeRequest } from '@ts6/common';
import type { PrismaClient } from '../../../generated/prisma/index.js';
import {
  toVideoQueueSessionOptions,
  type VideoQueueItem,
  type VideoQueueSessionOptions,
  type VideoQueueStore,
} from './video-queue.js';

const SOURCE_MODES: ReadonlySet<string> = new Set<VideoSourceModeRequest>(['auto', 'live', 'vod', 'file']);

export function videoQueueOptionsKey(botId: number): string {
  return `video_queue_options:${botId}`;
}

function parseOptions(value: string | undefined): VideoQueueSessionOptions | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return toVideoQueueSessionOptions(parsed as VideoQueueSessionOptions);
  } catch {
    return null;
  }
}

/** Load and save one bot's video lane and the options its session was started with. */
export function createVideoQueueStore(prisma: PrismaClient, botId: number): VideoQueueStore & {
  load(): Promise<{ items: VideoQueueItem[]; options: VideoQueueSessionOptions | null }>;
  delete(): Promise<void>;
} {
  const key = videoQueueOptionsKey(botId);
  const where = { musicBotId: botId };

  return {
    async save(items, options) {
      const kept = toVideoQueueSessionOptions(options ?? undefined);
      const value = kept ? JSON.stringify(kept) : null;
      await prisma.$transaction([
        prisma.videoQueueEntry.deleteMany({ where }),
        ...(items.length > 0
          ? [prisma.videoQueueEntry.createMany({
            data: items.map((item, position) => ({
              id: item.id,
              musicBotId: botId,
              position,
              source: item.source,
              title: item.title,
              durationSec: item.durationSec ?? null,
              sourceMode: item.sourceMode,
              addedBy: item.addedBy ?? null,
            })),
          })]
          : []),
        value
          ? prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
          : prisma.appSetting.deleteMany({ where: { key } }),
      ]);
    },

    async load() {
      const [rows, setting] = await Promise.all([
        prisma.videoQueueEntry.findMany({ where, orderBy: { position: 'asc' } }),
        prisma.appSetting.findUnique({ where: { key } }),
      ]);
      const items = rows.map((row): VideoQueueItem => ({
        id: row.id,
        source: row.source,
        title: row.title,
        ...(row.durationSec != null ? { durationSec: row.durationSec } : {}),
        sourceMode: SOURCE_MODES.has(row.sourceMode) ? (row.sourceMode as VideoSourceModeRequest) : 'auto',
        ...(row.addedBy ? { addedBy: row.addedBy } : {}),
      }));
      return { items, options: parseOptions(setting?.value) };
    },

    async delete() {
      await prisma.$transaction([
        prisma.videoQueueEntry.deleteMany({ where }),
        prisma.appSetting.deleteMany({ where: { key } }),
      ]);
    },
  };
}
