import type { PrismaClient } from '../../generated/prisma/index.js';
import { refreshPlaylist } from './iptv-service.js';

const TICK_MS = 60_000;

/**
 * Periodically refreshes IPTV playlists whose autoRefreshMinutes interval has elapsed.
 */
export function startIptvAutoRefresh(prisma: PrismaClient): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const playlists = await prisma.iptvPlaylist.findMany({
        where: { autoRefreshMinutes: { gt: 0 } },
        select: { id: true, autoRefreshMinutes: true, lastRefreshedAt: true },
      });

      const now = Date.now();
      for (const playlist of playlists) {
        const intervalMs = playlist.autoRefreshMinutes * 60_000;
        const last = playlist.lastRefreshedAt?.getTime() ?? 0;
        if (now - last < intervalMs) continue;

        try {
          await refreshPlaylist(prisma, playlist.id);
        } catch (err: any) {
          console.warn(`[IPTV] Auto-refresh failed for playlist ${playlist.id}: ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      console.warn(`[IPTV] Auto-refresh tick failed: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();

  return () => clearInterval(timer);
}
