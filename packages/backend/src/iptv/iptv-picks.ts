import type { IptvChannelPickInfo } from '@ts6/common';
import type { PrismaClient, Prisma, IptvChannel } from '../../generated/prisma/index.js';
import { AppError } from '../middleware/error-handler.js';

/** Match Task 10's stable key, including empty tvg-id falling back to name. */
export function iptvChannelKey(channel: Pick<IptvChannel, 'tvgId' | 'name'>): string {
  return channel.tvgId || channel.name;
}

/** Resolve saved picks against today's channels, never their transient IDs. */
export async function listIptvPicks(prisma: PrismaClient, serverConfigId: number, view: 'favourites' | 'recent'): Promise<IptvChannelPickInfo[]> {
  const picks = await prisma.iptvChannelPick.findMany({
    where: { serverConfigId, ...(view === 'favourites' ? { favourite: true } : { lastStreamedAt: { not: null } }) },
    orderBy: view === 'recent' ? [{ lastStreamedAt: 'desc' }, { playlistId: 'asc' }, { channelKey: 'asc' }] : [{ name: 'asc' }, { playlistId: 'asc' }, { channelKey: 'asc' }],
    ...(view === 'recent' ? { take: 20 } : {}),
  });
  if (!picks.length) return [];
  const current = new Map<string, Prisma.IptvChannelGetPayload<{ include: { playlist: { select: { name: true } } } }>>();
  // Favourites are unbounded; keep each SQLite expression and parameter list small.
  for (let offset = 0; offset < picks.length; offset += 100) {
    const channels = await prisma.iptvChannel.findMany({
      where: {
        playlist: { serverConfigId },
        OR: picks.slice(offset, offset + 100).map((pick) => ({ playlistId: pick.playlistId, OR: [{ tvgId: pick.channelKey }, { name: pick.channelKey }] })),
      },
      include: { playlist: { select: { name: true } } },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    for (const channel of channels) {
      const key = JSON.stringify([channel.playlistId, iptvChannelKey(channel)]);
      // Duplicate provider keys resolve consistently to the first playlist entry.
      if (!current.has(key)) current.set(key, channel);
    }
  }
  return picks.map((pick) => {
    const channel = current.get(JSON.stringify([pick.playlistId, pick.channelKey]));
    return {
      ...pick,
      lastStreamedAt: pick.lastStreamedAt?.toISOString() ?? null,
      channel: channel ? {
        id: channel.id, name: channel.name, logo: channel.logo, group: channel.groupTitle ?? '',
        playlistId: channel.playlistId, playlistName: channel.playlist.name, channelKey: iptvChannelKey(channel),
        tvgCountry: channel.tvgCountry, tvgLanguage: channel.tvgLanguage,
      } : null,
    };
  });
}

/** Record only a successful start/source change; retain favourites as recent ages out. */
export async function recordIptvRecent(prisma: PrismaClient, serverConfigId: number, channel: IptvChannel): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const playlist = await tx.iptvPlaylist.findFirst({ where: { id: channel.playlistId, serverConfigId }, select: { id: true } });
    if (!playlist) throw new AppError(404, 'Channel not found');
    const previous = await tx.iptvChannelPick.findFirst({
      where: { serverConfigId, lastStreamedAt: { not: null } }, orderBy: { lastStreamedAt: 'desc' }, select: { lastStreamedAt: true },
    });
    // Keep successive starts ordered even when they land in the same millisecond.
    const lastStreamedAt = new Date(Math.max(Date.now(), (previous?.lastStreamedAt?.getTime() ?? 0) + 1));
    const key = { serverConfigId, playlistId: channel.playlistId, channelKey: iptvChannelKey(channel) };
    await tx.iptvChannelPick.upsert({
      where: { serverConfigId_playlistId_channelKey: key },
      create: { ...key, name: channel.name, lastStreamedAt }, update: { name: channel.name, lastStreamedAt },
    });
    const expired = await tx.iptvChannelPick.findMany({
      where: { serverConfigId, lastStreamedAt: { not: null } },
      orderBy: [{ lastStreamedAt: 'desc' }, { playlistId: 'asc' }, { channelKey: 'asc' }], skip: 20,
      select: { playlistId: true, channelKey: true },
    });
    if (expired.length) {
      const where = { serverConfigId, OR: expired };
      await tx.iptvChannelPick.updateMany({ where: { ...where, favourite: true }, data: { lastStreamedAt: null } });
      await tx.iptvChannelPick.deleteMany({ where: { ...where, favourite: false } });
    }
  });
}

/** Recent is a convenience: a failed write must not turn a live stream into an error. */
export async function recordIptvRecentSafely(prisma: PrismaClient, serverConfigId: number, channel: IptvChannel): Promise<void> {
  try {
    await recordIptvRecent(prisma, serverConfigId, channel);
  } catch (err: any) {
    console.warn(`[IPTV] Could not record recent channel ${channel.id}: ${err?.message ?? err}`);
  }
}
