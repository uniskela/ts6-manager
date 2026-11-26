import type { Router } from 'express';
import { z } from 'zod';
import type { ListenerRemotePlaylist } from '@ts6/common';
import { authenticate, authorized, endpoint, fail } from './shared.js';

const PAGE_SIZE = 25;

const pageQuery = z.object({
  search: z.string().max(200).default(''),
  page: z.coerce.number().int().min(1).max(10000).default(1),
}).strict();

const songsQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
}).strict();

/** Visible to the remote: browse/request and this server or global. */
function visibleWhere(serverConfigId: number) {
  return {
    remoteAccess: { in: ['browse', 'request'] as const },
    OR: [{ serverConfigId }, { serverConfigId: null }],
  };
}

function songsOnServer(serverConfigId: number) {
  return { song: { serverConfigId } };
}

function remotePlaylist(
  playlist: { id: number; name: string; remoteAccess: string },
  tracks: Array<{ song: { duration: number | null } }>,
): ListenerRemotePlaylist {
  const trackCount = tracks.length;
  const duration = tracks.some(({ song }) => song.duration == null)
    ? null
    : tracks.reduce((sum, { song }) => sum + Number(song.duration), 0);
  return {
    id: playlist.id,
    name: playlist.name,
    trackCount,
    duration,
    wholeRequest: playlist.remoteAccess === 'request',
  };
}

function playlistIdParam(raw: unknown): number {
  const parsed = z.string().regex(/^[1-9]\d*$/).transform(Number)
    .refine(n => Number.isSafeInteger(n) && n > 0)
    .safeParse(raw);
  if (!parsed.success) fail(400, 'invalid_request', 'Invalid listener request.');
  return parsed.data;
}

/** Shared playlists (`GET /playlists`, `GET /playlists/:playlistId/songs`). */
export function registerPlaylistRoutes(router: Router): void {
  router.get('/playlists', endpoint(async (req, res) => {
    const query = pageQuery.safeParse(req.query);
    if (!query.success) fail(400, 'invalid_request', 'Invalid listener request.');
    const { binding } = await authorized(req, 'queue');
    const { search, page } = query.data;
    const serverConfigId = binding.serverConfigId;
    const rows = await req.app.locals.prisma.playlist.findMany({
      where: {
        ...visibleWhere(serverConfigId),
        name: { contains: search },
      },
      select: {
        id: true,
        name: true,
        remoteAccess: true,
        songs: {
          where: songsOnServer(serverConfigId),
          select: { song: { select: { duration: true } } },
        },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    await authenticate(req);
    res.json({
      playlists: rows.map((row: { id: number; name: string; remoteAccess: string; songs: Array<{ song: { duration: number | null } }> }) =>
        remotePlaylist(row, row.songs)),
      page,
      pageSize: PAGE_SIZE,
    });
  }));

  router.get('/playlists/:playlistId/songs', endpoint(async (req, res) => {
    const playlistId = playlistIdParam(req.params.playlistId);
    const query = songsQuery.safeParse(req.query);
    if (!query.success) fail(400, 'invalid_request', 'Invalid listener request.');
    const { binding } = await authorized(req, 'queue');
    const { page } = query.data;
    const serverConfigId = binding.serverConfigId;
    const playlist = await req.app.locals.prisma.playlist.findFirst({
      where: { id: playlistId, ...visibleWhere(serverConfigId) },
      select: {
        id: true,
        name: true,
        remoteAccess: true,
        songs: {
          where: songsOnServer(serverConfigId),
          select: { song: { select: { duration: true } } },
        },
      },
    });
    if (!playlist) fail(404, 'not_found', 'Playlist not found.');
    const songs = await req.app.locals.prisma.playlistSong.findMany({
      where: { playlistId: playlist.id, ...songsOnServer(serverConfigId) },
      select: { song: { select: { id: true, title: true, artist: true, duration: true } } },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    await authenticate(req);
    res.json({
      playlist: remotePlaylist(playlist, playlist.songs),
      songs: songs.map(({ song }: { song: { id: number; title: string; artist: string | null; duration: number | null } }) => song),
      page,
      pageSize: PAGE_SIZE,
    });
  }));
}
