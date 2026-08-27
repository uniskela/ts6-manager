/**
 * Background YouTube playlist import with job tracking.
 * Adapted from coom/ts6-manager (Aug 2026 playlist import series).
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import type { PrismaClient } from '../../../generated/prisma/index.js';
import { parseYouTubeUrl, getYouTubeUrlInfo, downloadYouTube } from './youtube.js';
import { loadMaxPlaylistImport } from '../../utils/app-settings.js';

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';

export type ImportJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  total: number;
  processed: number;
  downloaded: number;
  skipped: number;
  errors: string[];
  playlistId?: number;
  title?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, ImportJob>();

export function getImportJob(jobId: string): ImportJob | undefined {
  return jobs.get(jobId);
}

export interface StartImportOptions {
  playlistName?: string;
  playlistId?: number;
  reimport?: boolean;
}

export async function startYouTubePlaylistImport(
  prisma: PrismaClient,
  serverConfigId: number,
  url: string,
  options: StartImportOptions = {},
): Promise<string> {
  const jobId = randomUUID();
  const job: ImportJob = {
    id: jobId,
    status: 'pending',
    total: 0,
    processed: 0,
    downloaded: 0,
    skipped: 0,
    errors: [],
    startedAt: Date.now(),
  };
  jobs.set(jobId, job);

  runImport(prisma, serverConfigId, url, options, job).catch((err: Error) => {
    job.status = 'failed';
    job.errors.push(err.message);
    job.finishedAt = Date.now();
  });

  return jobId;
}

async function runImport(
  prisma: PrismaClient,
  serverConfigId: number,
  url: string,
  options: StartImportOptions,
  job: ImportJob,
): Promise<void> {
  job.status = 'running';
  const cap = await loadMaxPlaylistImport(prisma);
  const parsed = parseYouTubeUrl(url);

  let listId = parsed.listId;
  let probeUrl = url;

  // Smart URL detection: pure playlist vs watch?v=&list=
  if (parsed.listId && parsed.videoId) {
    probeUrl = parsed.playlistUrl ?? `https://www.youtube.com/playlist?list=${parsed.listId}`;
  } else if (parsed.listId && !parsed.videoId) {
    probeUrl = parsed.playlistUrl ?? url;
  } else if (!parsed.listId) {
    throw new Error('URL does not contain a YouTube playlist (list= parameter)');
  }

  const info = await getYouTubeUrlInfo(probeUrl);
  if (info.type !== 'playlist' || info.items.length === 0) {
    throw new Error('Could not resolve any videos from that playlist URL');
  }

  job.title = info.title;
  const items = info.items.slice(0, cap);
  job.total = items.length;

  let playlistId = options.playlistId;
  if (playlistId) {
    const existing = await prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!existing) throw new Error('Playlist not found');
    if (existing.mode === 'local' && !existing.youtubePlaylistId) {
      throw new Error(
        'Cannot import a YouTube playlist into a local-only playlist — create or select a stream playlist',
      );
    }
    await prisma.playlist.update({
      where: { id: playlistId },
      data: {
        mode: 'stream',
        ...(options.playlistName ? { name: options.playlistName } : {}),
        ...(listId ? { youtubePlaylistId: listId, serverConfigId } : { serverConfigId }),
      },
    });
  } else {
    const created = await prisma.playlist.create({
      data: {
        name: options.playlistName || info.title || 'Imported Playlist',
        mode: 'stream',
        youtubePlaylistId: listId ?? null,
        serverConfigId,
      },
    });
    playlistId = created.id;
  }
  job.playlistId = playlistId;

  for (const item of items) {
    const watchUrl = `https://www.youtube.com/watch?v=${item.id}`;
    job.processed++;

    try {
      let song = await prisma.song.findFirst({
        where: { sourceUrl: watchUrl, serverConfigId },
      });

      if (song && !options.reimport) {
        job.skipped++;
      } else if (song && options.reimport) {
        // Re-import queues already-downloaded tracks (re-add to playlist)
        job.skipped++;
      } else {
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
      }

      if (song) {
        const link = await prisma.playlistSong.findFirst({
          where: { playlistId, songId: song.id },
        });
        if (!link) {
          const maxPos = await prisma.playlistSong.aggregate({
            where: { playlistId },
            _max: { position: true },
          });
          await prisma.playlistSong.create({
            data: {
              playlistId,
              songId: song.id,
              position: (maxPos._max.position ?? -1) + 1,
            },
          });
        }
      }
    } catch (err: any) {
      job.errors.push(`${item.title}: ${err.message}`);
    }
  }

  job.status = job.errors.length === job.total ? 'failed' : 'completed';
  job.finishedAt = Date.now();
}
