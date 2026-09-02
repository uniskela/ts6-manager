import type { PrismaClient } from '../../generated/prisma/index.js';
import { validateUrl } from '../utils/url-validator.js';
import { parseM3U } from './m3u-parser.js';

// Cap the downloaded playlist so a hostile/huge URL can't exhaust memory.
const MAX_PLAYLIST_BYTES = 64 * 1024 * 1024; // 64 MB
const FETCH_TIMEOUT_MS = 30000;

export interface RefreshResult {
  channelCount: number;
}

/**
 * Fetches a playlist's M3U source (SSRF-guarded), parses it, and replaces the
 * playlist's channels transactionally. Records lastRefreshedAt / lastError.
 */
export async function refreshPlaylist(prisma: PrismaClient, playlistId: number): Promise<RefreshResult> {
  const playlist = await prisma.iptvPlaylist.findUnique({ where: { id: playlistId } });
  if (!playlist) throw new Error('Playlist not found');

  try {
    const content = await fetchPlaylist(playlist.url);
    const parsed = parseM3U(content);

    // Replace channels atomically: drop old, insert new (bounded batch inserts).
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
