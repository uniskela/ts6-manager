/**
 * Background YouTube / Apple Music playlist import with job tracking.
 * Adapted from coom/ts6-manager (Aug 2026 playlist import series).
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import type { PrismaClient, Song } from '../../../generated/prisma/index.js';
import { parseYouTubeUrl, getYouTubeUrlInfo, downloadYouTube } from './youtube.js';
import { isYouTubePlaylistUrl, planImport, youtubeWatchUrl } from './playlist-import-plan.js';
import {
  appleMusicTrackToYouTubeUrl,
  isAppleMusicShareUrl,
  resolveAppleMusicTracks,
  type AppleMusicTrack,
} from './apple-music.js';
import { loadMaxPlaylistImport } from '../../utils/app-settings.js';
import type { VoiceBotManager } from '../voice-bot-manager.js';
import type { VoiceBot } from '../voice-bot.js';

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';
const APPLE_MUSIC_YT_CONCURRENCY = 8;

export type ImportJobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ImportJobPhase = 'matching' | 'importing';

export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  phase?: ImportJobPhase;
  total: number;
  processed: number;
  downloaded: number;
  registered: number;
  enqueued: number;
  skipped: number;
  errors: string[];
  playlistId?: number;
  musicBotId?: number;
  title?: string;
  /** Apple Music source tracks queued for YouTube matching. */
  matchTotal?: number;
  matchProcessed?: number;
  matched?: number;
  /** Total tracks in source playlist before import cap (Apple Music / YouTube). */
  sourceTrackCount?: number;
  /** Active max_playlist_import cap for this job. */
  importCap?: number;
  startedAt: number;
  finishedAt?: number;
}

interface ImportItem {
  id: string;
  title: string;
  artist?: string;
  duration?: number;
}

const jobs = new Map<string, ImportJob>();

export function getImportJob(jobId: string): ImportJob | undefined {
  return jobs.get(jobId);
}

export interface StartImportOptions {
  playlistName?: string;
  playlistId?: number;
  reimport?: boolean;
  /** Enqueue imported tracks on this running music bot. */
  musicBotId?: number;
  clearFirst?: boolean;
}

export interface StartImportContext {
  voiceBotManager?: VoiceBotManager;
}

export async function startYouTubePlaylistImport(
  prisma: PrismaClient,
  serverConfigId: number,
  url: string,
  options: StartImportOptions = {},
  context: StartImportContext = {},
): Promise<string> {
  const jobId = randomUUID();
  const job: ImportJob = {
    id: jobId,
    status: 'pending',
    total: 0,
    processed: 0,
    downloaded: 0,
    registered: 0,
    enqueued: 0,
    skipped: 0,
    errors: [],
    startedAt: Date.now(),
  };
  jobs.set(jobId, job);

  runImport(prisma, serverConfigId, url, options, job, context).catch((err: Error) => {
    job.status = 'failed';
    job.errors.push(err.message);
    job.finishedAt = Date.now();
  });

  return jobId;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function matchAppleTracksToImportItems(
  tracks: AppleMusicTrack[],
  job: ImportJob,
): Promise<ImportItem[]> {
  job.phase = 'matching';
  job.matchTotal = tracks.length;
  job.matchProcessed = 0;
  job.matched = 0;

  console.log(
    `[MusicLibrary] Apple Music import “${job.title || 'playlist'}”: matching ${tracks.length} tracks on YouTube (concurrency ${APPLE_MUSIC_YT_CONCURRENCY})`,
  );

  const matched = await mapPool<AppleMusicTrack, ImportItem | null>(
    tracks,
    APPLE_MUSIC_YT_CONCURRENCY,
    async (track) => {
      try {
        const ytUrl = await appleMusicTrackToYouTubeUrl(track);
        if (!ytUrl) {
          job.matchProcessed = (job.matchProcessed ?? 0) + 1;
          return null;
        }
        const videoId = parseYouTubeUrl(ytUrl).videoId;
        if (!videoId) {
          job.matchProcessed = (job.matchProcessed ?? 0) + 1;
          return null;
        }
        job.matched = (job.matched ?? 0) + 1;
        job.matchProcessed = (job.matchProcessed ?? 0) + 1;
        return {
          id: videoId,
          title: track.title,
          artist: track.artist || 'Unknown',
          duration: 0,
        };
      } catch {
        job.matchProcessed = (job.matchProcessed ?? 0) + 1;
        return null;
      }
    },
  );

  const items = matched.filter((item): item is ImportItem => item != null);
  console.log(
    `[MusicLibrary] Apple Music import match complete: ${items.length}/${tracks.length} YouTube hits`,
  );
  return items;
}

async function resolveImportItems(
  url: string,
  cap: number,
  job: ImportJob,
): Promise<{ items: ImportItem[]; listId: string | null; title?: string }> {
  if (isAppleMusicShareUrl(url)) {
    const am = await resolveAppleMusicTracks(url);
    job.title = am.title;
    job.sourceTrackCount = am.tracks.length;
    job.importCap = cap;
    if (am.tracks.length > cap) {
      console.log(
        `[MusicLibrary] Apple Music “${am.title || 'playlist'}”: ${am.tracks.length} tracks — importing first ${cap} (max_playlist_import cap; raise in Settings → Limits)`,
      );
    }
    const tracks = am.tracks.slice(0, cap);
    const items = await matchAppleTracksToImportItems(tracks, job);
    if (!items.length) {
      throw new Error('No YouTube matches found for that Apple Music URL');
    }
    return { items, listId: null, title: am.title };
  }

  const parsed = parseYouTubeUrl(url);
  let listId = parsed.listId;
  let probeUrl = url;

  if (!isYouTubePlaylistUrl(url) && !parsed.listId) {
    throw new Error('URL does not contain a YouTube playlist (list= parameter)');
  }

  if (parsed.listId && parsed.videoId) {
    // Video opened from playlist — not a playlist import target.
    throw new Error('URL is a single video, not a playlist');
  }

  if (parsed.listId && !parsed.videoId) {
    probeUrl = parsed.playlistUrl ?? url;
  } else if (!parsed.listId) {
    throw new Error('URL does not contain a YouTube playlist (list= parameter)');
  }

  const info = await getYouTubeUrlInfo(probeUrl);
  if (info.type !== 'playlist' || info.items.length === 0) {
    throw new Error('Could not resolve any videos from that playlist URL');
  }

  job.sourceTrackCount = info.items.length;
  job.importCap = cap;
  if (info.items.length > cap) {
    console.log(
      `[MusicLibrary] YouTube playlist “${info.title || 'playlist'}”: ${info.items.length} videos — importing first ${cap} (max_playlist_import cap)`,
    );
  }

  const items = info.items.map((item) => ({
    id: item.id,
    title: item.title,
    artist: item.artist,
    duration: item.duration,
  }));

  return { items, listId: listId ?? null, title: info.title };
}

async function ensurePlaylistSongLink(
  prisma: PrismaClient,
  playlistId: number,
  songId: number,
): Promise<void> {
  const link = await prisma.playlistSong.findFirst({
    where: { playlistId, songId },
  });
  if (!link) {
    const maxPos = await prisma.playlistSong.aggregate({
      where: { playlistId },
      _max: { position: true },
    });
    await prisma.playlistSong.create({
      data: {
        playlistId,
        songId,
        position: (maxPos._max.position ?? -1) + 1,
      },
    });
  }
}

async function registerStreamSong(
  prisma: PrismaClient,
  serverConfigId: number,
  watchUrl: string,
  item: ImportItem,
): Promise<Song> {
  const existing = await prisma.song.findFirst({
    where: { sourceUrl: watchUrl, serverConfigId },
  });
  if (existing) return existing;

  return prisma.song.create({
    data: {
      title: item.title || watchUrl,
      artist: item.artist ?? null,
      duration: item.duration ?? null,
      filePath: '',
      source: 'youtube',
      sourceUrl: watchUrl,
      fileSize: null,
      serverConfigId,
    },
  });
}

function enqueueSongOnBot(bot: VoiceBot, song: Song, job: ImportJob): void {
  bot.queue.add({
    id: String(song.id),
    title: song.title,
    artist: song.artist ?? undefined,
    duration: song.duration ?? undefined,
    filePath: song.filePath,
    source: song.source as 'local' | 'youtube' | 'url',
    sourceUrl: song.sourceUrl ?? undefined,
  });
  job.enqueued++;
}

async function runImport(
  prisma: PrismaClient,
  serverConfigId: number,
  url: string,
  options: StartImportOptions,
  job: ImportJob,
  context: StartImportContext,
): Promise<void> {
  job.status = 'running';
  const cap = await loadMaxPlaylistImport(prisma);
  const isApple = isAppleMusicShareUrl(url);
  const queueTarget = options.musicBotId != null;
  const playlistTarget = options.playlistId != null || !queueTarget;

  let queueBot: VoiceBot | undefined;
  if (queueTarget) {
    const dbBot = await prisma.musicBot.findUnique({ where: { id: options.musicBotId! } });
    if (!dbBot) throw new Error('Music bot not found');
    if (dbBot.serverConfigId !== serverConfigId) {
      throw new Error('Music bot does not belong to this server');
    }
    queueBot = context.voiceBotManager?.getBot(options.musicBotId!);
    if (
      !queueBot ||
      (queueBot.status !== 'connected' &&
        queueBot.status !== 'playing' &&
        queueBot.status !== 'paused')
    ) {
      throw new Error('Music bot is not running — start the bot before importing to its queue');
    }
    job.musicBotId = options.musicBotId;
    if (options.clearFirst) {
      queueBot.queue.clear();
    }
  }

  const { items: allItems, listId, title } = await resolveImportItems(url, cap, job);
  job.phase = 'importing';

  let playlistId = options.playlistId;
  let playlistMode: 'local' | 'stream' = 'stream';

  if (playlistTarget) {
    if (playlistId) {
      const existing = await prisma.playlist.findUnique({ where: { id: playlistId } });
      if (!existing) throw new Error('Playlist not found');
      playlistMode = existing.mode === 'stream' ? 'stream' : 'local';

      if (!isApple && existing.mode === 'local' && !existing.youtubePlaylistId) {
        throw new Error(
          'Cannot import a YouTube playlist into a local-only playlist — create or select a stream playlist',
        );
      }

      await prisma.playlist.update({
        where: { id: playlistId },
        data: {
          ...(isApple
            ? { serverConfigId }
            : {
                mode: 'stream',
                ...(listId ? { youtubePlaylistId: listId, serverConfigId } : { serverConfigId }),
              }),
          ...(options.playlistName ? { name: options.playlistName } : {}),
        },
      });
    } else {
      const created = await prisma.playlist.create({
        data: {
          name: options.playlistName || title || 'Imported Playlist',
          mode: 'stream',
          youtubePlaylistId: listId ?? null,
          serverConfigId,
        },
      });
      playlistId = created.id;
      playlistMode = 'stream';
    }
    job.playlistId = playlistId;
  }

  if (title) job.title = title;

  let items = allItems;
  if (playlistTarget && playlistId) {
    const attachedRows = await prisma.playlistSong.findMany({
      where: { playlistId },
      include: { song: { select: { sourceUrl: true } } },
    });
    const attached = new Set(
      attachedRows.map((row) => row.song.sourceUrl).filter((u): u is string => Boolean(u)),
    );
    const plan = planImport(
      allItems.map((item) => ({
        id: item.id,
        title: item.title || item.id,
        url: youtubeWatchUrl(item.id),
      })),
      attached,
      cap,
    );
    job.skipped = plan.alreadyPresent.length;
    const byId = new Map(allItems.map((item) => [item.id, item]));
    const alreadyPresent = plan.alreadyPresent
      .map((entry) => byId.get(entry.id))
      .filter((item): item is ImportItem => Boolean(item));
    const toImport = plan.toImport
      .map((entry) => byId.get(entry.id))
      .filter((item): item is ImportItem => Boolean(item));
    items = [...alreadyPresent, ...toImport];
  } else {
    items = allItems.slice(0, cap);
  }

  job.total = items.length;

  // Queue-only imports always register on-demand (no bulk download).
  const needsDownload = playlistTarget && playlistMode === 'local';

  for (const item of items) {
    const watchUrl = youtubeWatchUrl(item.id);
    job.processed++;

    try {
      let song = await prisma.song.findFirst({
        where: { sourceUrl: watchUrl, serverConfigId },
      });

      if (song && needsDownload && !song.filePath) {
        const { filePath, info: dlInfo } = await downloadYouTube(watchUrl, MUSIC_DIR);
        const fileStats = fs.statSync(filePath);
        song = await prisma.song.update({
          where: { id: song.id },
          data: {
            title: dlInfo.title,
            artist: dlInfo.artist,
            duration: dlInfo.duration,
            filePath,
            fileSize: fileStats.size,
          },
        });
        job.downloaded++;
      } else if (!song) {
        if (needsDownload) {
          const { filePath, info: dlInfo } = await downloadYouTube(watchUrl, MUSIC_DIR);
          const fileStats = fs.statSync(filePath);
          song = await prisma.song.create({
            data: {
              title: dlInfo.title,
              artist: dlInfo.artist,
              duration: dlInfo.duration,
              filePath,
              source: 'youtube',
              sourceUrl: watchUrl,
              fileSize: fileStats.size,
              serverConfigId,
            },
          });
          job.downloaded++;
        } else {
          song = await registerStreamSong(prisma, serverConfigId, watchUrl, item);
          job.registered++;
        }
      } else if (needsDownload && !options.reimport) {
        job.skipped++;
      } else if (needsDownload && options.reimport) {
        job.skipped++;
      }

      if (song && playlistId) {
        await ensurePlaylistSongLink(prisma, playlistId, song.id);
      }
      if (song && queueBot) {
        enqueueSongOnBot(queueBot, song, job);
      }
    } catch (err: any) {
      job.errors.push(`${item.title}: ${err.message}`);
    }
  }

  job.status = job.errors.length === job.total ? 'failed' : 'completed';
  job.finishedAt = Date.now();
}
