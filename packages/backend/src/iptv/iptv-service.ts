import type { PrismaClient } from '../../generated/prisma/index.js';
import { validateUrl } from '../utils/url-validator.js';
import { parseM3U, type ParsedChannel } from './m3u-parser.js';
import {
  deleteIptvSourceFile,
  decodePlaylistUpload,
  readIptvSourceFile,
  sanitizeOriginalFilename,
  writeIptvSourceFile,
} from './iptv-storage.js';

// Cap the downloaded playlist so a hostile/huge URL can't exhaust memory.
const MAX_PLAYLIST_BYTES = 64 * 1024 * 1024; // 64 MB
const FETCH_TIMEOUT_MS = 30000;

export type IptvSourceType = 'url' | 'upload';

export interface RefreshResult {
  channelCount: number;
}

export interface CreateUploadedPlaylistInput {
  name: string;
  serverConfigId: number;
  fileBuffer: Buffer;
  originalFilename?: string | null;
}

export interface ReplaceUploadedPlaylistInput {
  playlistId: number;
  fileBuffer: Buffer;
  originalFilename?: string | null;
}

/**
 * Fetches or re-reads a playlist's M3U source, parses it, and replaces the
 * playlist's channels transactionally. Records lastRefreshedAt / lastError.
 *
 * - sourceType=url: HTTP(S) fetch (SSRF-guarded)
 * - sourceType=upload: re-read persisted file under data/iptv/
 */
export async function refreshPlaylist(prisma: PrismaClient, playlistId: number): Promise<RefreshResult> {
  const playlist = await prisma.iptvPlaylist.findUnique({ where: { id: playlistId } });
  if (!playlist) throw new Error('Playlist not found');

  try {
    const content = await loadPlaylistContent(playlist);
    const parsed = parseM3U(content);
    // Uploaded sources must produce channels; URL refresh may still clear channels
    // if a remote provider temporarily returns an empty list.
    if ((playlist.sourceType || 'url') === 'upload' && parsed.length === 0) {
      throw new Error('Playlist contains no valid channels');
    }

    await replaceChannels(prisma, playlistId, parsed);

    await prisma.iptvPlaylist.update({
      where: { id: playlistId },
      data: { lastRefreshedAt: new Date(), lastError: null },
    });

    return { channelCount: parsed.length };
  } catch (err: any) {
    await prisma.iptvPlaylist.update({
      where: { id: playlistId },
      data: { lastError: String(err?.message ?? err).slice(0, 500) },
    });
    throw err;
  }
}

async function loadPlaylistContent(playlist: {
  sourceType: string;
  url: string | null;
  sourcePath: string | null;
}): Promise<string> {
  const sourceType = (playlist.sourceType || 'url') as IptvSourceType;
  if (sourceType === 'upload') {
    if (!playlist.sourcePath) throw new Error('Uploaded playlist is missing its source file');
    return readIptvSourceFile(playlist.sourcePath);
  }
  if (!playlist.url) throw new Error('Playlist URL is missing');
  return fetchPlaylist(playlist.url);
}

export async function createUploadedPlaylist(
  prisma: PrismaClient,
  input: CreateUploadedPlaylistInput,
): Promise<{ id: number; channelCount: number }> {
  const content = decodePlaylistUpload(input.fileBuffer);
  const parsed = parseM3U(content);
  if (parsed.length === 0) {
    throw new Error('Uploaded playlist contains no valid channels');
  }

  const originalFilename = sanitizeOriginalFilename(input.originalFilename);
  const relativePath = writeIptvSourceFile(content, originalFilename);

  try {
    const playlist = await prisma.iptvPlaylist.create({
      data: {
        name: input.name,
        sourceType: 'upload',
        url: null,
        sourcePath: relativePath,
        originalFilename,
        serverConfigId: input.serverConfigId,
        autoRefreshMinutes: 0,
        lastRefreshedAt: new Date(),
        lastError: null,
      },
    });

    try {
      await replaceChannels(prisma, playlist.id, parsed);
    } catch (err) {
      await prisma.iptvPlaylist.delete({ where: { id: playlist.id } }).catch(() => {});
      throw err;
    }

    return { id: playlist.id, channelCount: parsed.length };
  } catch (err) {
    deleteIptvSourceFile(relativePath);
    throw err;
  }
}

/**
 * Replace the stored source for an uploaded playlist. Writes the new file first;
 * on success updates DB + channels and deletes the old file. On failure removes
 * the new file and leaves the previous source/channels intact.
 */
export async function replaceUploadedPlaylist(
  prisma: PrismaClient,
  input: ReplaceUploadedPlaylistInput,
): Promise<RefreshResult> {
  const playlist = await prisma.iptvPlaylist.findUnique({ where: { id: input.playlistId } });
  if (!playlist) throw new Error('Playlist not found');
  if ((playlist.sourceType || 'url') !== 'upload') {
    throw new Error('Only uploaded playlists can replace their source file');
  }

  const content = decodePlaylistUpload(input.fileBuffer);
  const parsed = parseM3U(content);
  if (parsed.length === 0) {
    throw new Error('Uploaded playlist contains no valid channels');
  }

  const originalFilename = sanitizeOriginalFilename(input.originalFilename);
  const previousPath = playlist.sourcePath;
  const newRelative = writeIptvSourceFile(content, originalFilename);

  try {
    await replaceChannels(prisma, playlist.id, parsed);
    await prisma.iptvPlaylist.update({
      where: { id: playlist.id },
      data: {
        sourcePath: newRelative,
        originalFilename,
        lastRefreshedAt: new Date(),
        lastError: null,
      },
    });
  } catch (err: any) {
    deleteIptvSourceFile(newRelative);
    await prisma.iptvPlaylist.update({
      where: { id: playlist.id },
      data: { lastError: String(err?.message ?? err).slice(0, 500) },
    }).catch(() => {});
    throw err;
  }

  if (previousPath && previousPath !== newRelative) {
    deleteIptvSourceFile(previousPath);
  }

  return { channelCount: parsed.length };
}

export async function deletePlaylistWithSource(
  prisma: PrismaClient,
  playlistId: number,
): Promise<void> {
  const playlist = await prisma.iptvPlaylist.findUnique({ where: { id: playlistId } });
  if (!playlist) throw new Error('Playlist not found');
  const sourcePath = playlist.sourcePath;
  await prisma.iptvPlaylist.delete({ where: { id: playlistId } });
  if ((playlist.sourceType || 'url') === 'upload') {
    deleteIptvSourceFile(sourcePath);
  }
}

/** Shape playlist rows for API responses — never expose absolute paths. */
export function toPlaylistSummary(p: {
  id: number;
  name: string;
  sourceType: string;
  url: string | null;
  originalFilename: string | null;
  serverConfigId: number;
  autoRefreshMinutes: number;
  lastRefreshedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  _count?: { channels: number };
  channelCount?: number;
}) {
  const sourceType = (p.sourceType === 'upload' ? 'upload' : 'url') as IptvSourceType;
  return {
    id: p.id,
    name: p.name,
    sourceType,
    url: sourceType === 'url' ? p.url : null,
    originalFilename: sourceType === 'upload' ? p.originalFilename : null,
    serverConfigId: p.serverConfigId,
    autoRefreshMinutes: p.autoRefreshMinutes,
    lastRefreshedAt: p.lastRefreshedAt,
    lastError: p.lastError,
    channelCount: p.channelCount ?? p._count?.channels ?? 0,
    createdAt: p.createdAt,
  };
}

async function replaceChannels(
  prisma: PrismaClient,
  playlistId: number,
  parsed: ParsedChannel[],
): Promise<void> {
  await prisma.$transaction([
    prisma.iptvChannel.deleteMany({ where: { playlistId } }),
    ...chunk(parsed, 1000).map((batch, ci) =>
      prisma.iptvChannel.createMany({
        data: batch.map((c, i) => ({
          playlistId,
          name: c.name,
          url: c.url,
          logo: c.logo ?? null,
          groupTitle: c.groupTitle ?? null,
          tvgId: c.tvgId ?? null,
          position: ci * 1000 + i,
        })),
      }),
    ),
  ]);
}

async function fetchPlaylist(url: string): Promise<string> {
  const MAX_REDIRECTS = 5;
  let current = url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const check = await validateUrl(current, { allowedProtocols: ['http:', 'https:'] });
      if (!check.valid) throw new Error(`Playlist URL blocked: ${check.error}`);

      const res = await fetch(current, { signal: controller.signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error('Redirect missing Location header');
        current = new URL(location, current).href;
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} fetching playlist`);
      if (!res.body) return await res.text();

      // Stream with a byte cap.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_PLAYLIST_BYTES) {
            try { await reader.cancel(); } catch {}
            throw new Error(`Playlist exceeds ${MAX_PLAYLIST_BYTES} byte limit`);
          }
          chunks.push(value);
        }
      }
      return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
    }

    throw new Error('Too many redirects while fetching playlist');
  } finally {
    clearTimeout(timer);
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
