import { randomUUID } from 'node:crypto';
import { Router, Request, Response } from 'express';
import type { PlaylistRemoteAccess } from '@ts6/common';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { actorFromRequest, recordLocalSuccess } from '../audit/index.js';
import { buildRow } from '../audit/writer.js';

export const playlistRoutes: Router = Router();

playlistRoutes.use(requireRole('admin'));

type PlaylistMode = 'local' | 'stream';

function normalizePlaylistMode(raw: unknown, fallback: PlaylistMode = 'local'): PlaylistMode {
  if (raw === 'stream' || raw === 'local') return raw;
  return fallback;
}

function normalizePlaylistRemoteAccess(raw: unknown, fallback: PlaylistRemoteAccess = 'hidden'): PlaylistRemoteAccess {
  if (raw === 'hidden' || raw === 'browse' || raw === 'request') return raw;
  return fallback;
}

/** Reject unknown values when the client sends remoteAccess explicitly. */
function parsePlaylistRemoteAccess(raw: unknown): PlaylistRemoteAccess {
  if (raw === 'hidden' || raw === 'browse' || raw === 'request') return raw;
  throw new AppError(400, 'remoteAccess must be hidden, browse, or request');
}

/** YouTube-imported playlists must stay stream-mode even if DB defaulted to local. */
function effectivePlaylistMode(p: { mode: string; youtubePlaylistId?: string | null }): PlaylistMode {
  if (p.youtubePlaylistId) return 'stream';
  return normalizePlaylistMode(p.mode);
}

function songMatchesMode(source: string, mode: PlaylistMode): boolean {
  if (mode === 'local') return source === 'local';
  // stream playlists accept youtube + direct url tracks
  return source === 'youtube' || source === 'url';
}

function mapPlaylistSummary(p: {
  id: number;
  name: string;
  mode: string;
  remoteAccess?: string | null;
  musicBotId: number | null;
  youtubePlaylistId: string | null;
  serverConfigId: number | null;
  createdAt: Date;
  _count: { songs: number };
}) {
  return {
    id: p.id,
    name: p.name,
    mode: effectivePlaylistMode(p),
    remoteAccess: normalizePlaylistRemoteAccess(p.remoteAccess),
    musicBotId: p.musicBotId,
    youtubePlaylistId: p.youtubePlaylistId,
    serverConfigId: p.serverConfigId,
    songCount: p._count.songs,
    createdAt: p.createdAt,
  };
}

// GET / — List playlists
playlistRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const raw = req.query.serverConfigId;
    if (raw !== undefined && !(typeof raw === 'string' && /^[1-9]\d*$/.test(raw))) {
      throw new AppError(400, 'serverConfigId must be a positive whole number');
    }
    const serverConfigId = raw === undefined ? undefined : Number(raw);
    const playlists = await prisma.playlist.findMany({
      // Legacy playlists without an explicit server can still belong to a bot.
      // Match the same server eligibility enforced when choosing an Auto-DJ source.
      where: serverConfigId ? {
        AND: [
          { OR: [{ serverConfigId }, { serverConfigId: null }] },
          { OR: [{ musicBot: null }, { musicBot: { serverConfigId } }] },
        ],
      } : undefined,
      include: { _count: { select: { songs: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(playlists.map(mapPlaylistSummary));
  } catch (err) {
    next(err);
  }
});

// GET /:id — Get playlist with songs
playlistRoutes.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(req.params.id as string);
    const playlist = await prisma.playlist.findUnique({
      where: { id },
      include: {
        songs: {
          include: { song: true },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!playlist) throw new AppError(404, 'Playlist not found');

    res.json({
      id: playlist.id,
      name: playlist.name,
      mode: effectivePlaylistMode(playlist),
      remoteAccess: normalizePlaylistRemoteAccess(playlist.remoteAccess),
      musicBotId: playlist.musicBotId,
      youtubePlaylistId: playlist.youtubePlaylistId,
      serverConfigId: playlist.serverConfigId,
      songCount: playlist.songs.length,
      createdAt: playlist.createdAt,
      songs: playlist.songs.map((ps: any) => ({
        id: ps.song.id,
        title: ps.song.title,
        artist: ps.song.artist,
        duration: ps.song.duration,
        source: ps.song.source,
        sourceUrl: ps.song.sourceUrl,
        fileSize: ps.song.fileSize,
        createdAt: ps.song.createdAt,
        position: ps.position,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST / — Create playlist
playlistRoutes.post('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, musicBotId, mode, serverConfigId, remoteAccess } = req.body;
    if (!name) throw new AppError(400, 'name is required');
    const playlistMode = normalizePlaylistMode(mode, 'local');
    const playlistRemoteAccess =
      remoteAccess === undefined ? undefined : parsePlaylistRemoteAccess(remoteAccess);
    // Playlists belong to the server they were created on; without one they stay
    // shared like legacy playlists.
    if (serverConfigId != null && !(Number.isInteger(serverConfigId) && serverConfigId > 0)) {
      throw new AppError(400, 'serverConfigId must be a positive whole number');
    }
    if (serverConfigId != null && !(await prisma.tsServerConfig.findUnique({ where: { id: serverConfigId }, select: { id: true } }))) {
      throw new AppError(400, `Server ${serverConfigId} does not exist`);
    }

    const createData = {
      name,
      mode: playlistMode,
      musicBotId: musicBotId ? parseInt(musicBotId) : null,
      serverConfigId: serverConfigId ?? null,
      ...(playlistRemoteAccess !== undefined ? { remoteAccess: playlistRemoteAccess } : {}),
    };

    const playlist =
      playlistRemoteAccess !== undefined && playlistRemoteAccess !== 'hidden'
        ? (
            await recordLocalSuccess(
              prisma,
              {
                actor: actorFromRequest(req.user),
                action: 'playlist.remote_access_update',
                connectionId: serverConfigId ?? null,
                target: { type: 'playlist', id: 0 },
              },
              async (tx) => tx.playlist.create({ data: createData }),
              { resolveTargetId: (created) => created.id },
            )
          ).result
        : await prisma.playlist.create({ data: createData });

    res.status(201).json({
      id: playlist.id,
      name: playlist.name,
      mode: normalizePlaylistMode(playlist.mode),
      remoteAccess: normalizePlaylistRemoteAccess(playlist.remoteAccess),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /:id — Update playlist
playlistRoutes.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(req.params.id as string);
    const { name, musicBotId, mode, remoteAccess } = req.body;

    const data: Record<string, unknown> = {};
    if (name != null) data.name = name;
    if (musicBotId !== undefined) data.musicBotId = musicBotId ? parseInt(musicBotId) : null;
    if (mode !== undefined) data.mode = normalizePlaylistMode(mode);

    let nextRemoteAccess: PlaylistRemoteAccess | undefined;
    if (remoteAccess !== undefined) {
      nextRemoteAccess = parsePlaylistRemoteAccess(remoteAccess);
      data.remoteAccess = nextRemoteAccess;
    }

    await prisma.$transaction(async (tx: any) => {
      const current = await tx.playlist.findUnique({ where: { id } });
      if (!current) throw new AppError(404, 'Playlist not found');

      if (Object.keys(data).length === 0) return;

      const visibilityChanged =
        nextRemoteAccess !== undefined &&
        nextRemoteAccess !== normalizePlaylistRemoteAccess(current.remoteAccess);

      await tx.playlist.update({ where: { id }, data });

      if (visibilityChanged) {
        await tx.adminAuditEvent.create({
          data: buildRow({
            actor: actorFromRequest(req.user),
            action: 'playlist.remote_access_update',
            connectionId: current.serverConfigId ?? null,
            target: { type: 'playlist', id },
            operationId: randomUUID(),
            outcome: 'success',
            resultCode: 'ok',
            completedAt: new Date(),
          }),
        });
      }
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — Delete playlist
playlistRoutes.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.playlist.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

const MAX_SONGS_PER_ADD = 1000;

async function appendSongsOnce(
  prisma: any,
  playlistId: number,
  songIds: number[],
): Promise<number> {
  return prisma.$transaction(async (tx: any) => {
    const maxPos = await tx.playlistSong.aggregate({
      where: { playlistId },
      _max: { position: true },
    });
    let nextPosition = (maxPos._max.position ?? -1) + 1;
    let added = 0;

    for (const songId of songIds) {
      const existing = await tx.playlistSong.findUnique({
        where: { playlistId_songId: { playlistId, songId } },
      });
      if (existing) continue;
      await tx.playlistSong.create({
        data: { playlistId, songId, position: nextPosition },
      });
      nextPosition++;
      added++;
    }
    return added;
  });
}

/** SQLite write conflicts surface from Prisma as P2034 or a "database is locked" error. */
function isWriteConflict(err: any): boolean {
  return err?.code === 'P2034' || /database is locked|SQLITE_BUSY/i.test(String(err?.message ?? ''));
}

/**
 * Append songs in one transaction so a batch lands whole and concurrent adds
 * cannot share a position. A conflicting writer can abort the transaction, so
 * the whole thing (including the position read) is retried a few times.
 */
async function appendSongsToPlaylist(
  prisma: any,
  playlistId: number,
  songIds: number[],
): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await appendSongsOnce(prisma, playlistId, songIds);
    } catch (err) {
      if (attempt >= 3 || !isWriteConflict(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

// POST /:id/songs — Add one song ({ songId }) or several ({ songIds }) to a playlist.
// Songs already in the playlist are skipped; `added` counts only new rows.
playlistRoutes.post('/:id/songs', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const playlistId = parseInt(req.params.id as string);
    const { songId, songIds } = req.body;
    const rawIds: unknown[] = Array.isArray(songIds) ? songIds : songId ? [songId] : [];
    const ids = [...new Set(rawIds.map((id) => parseInt(String(id))))];
    if (ids.length === 0) throw new AppError(400, 'songId is required');
    if (ids.some((id) => Number.isNaN(id))) throw new AppError(400, 'songIds must be numbers');
    if (ids.length > MAX_SONGS_PER_ADD) throw new AppError(400, `At most ${MAX_SONGS_PER_ADD} songs per request`);

    const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!playlist) throw new AppError(404, 'Playlist not found');

    const songs: { id: number; source: string }[] = await prisma.song.findMany({
      where: { id: { in: ids } },
      select: { id: true, source: true },
    });
    if (songs.length !== ids.length) {
      throw new AppError(404, ids.length === 1 ? 'Song not found' : 'One or more songs not found');
    }

    const mode = effectivePlaylistMode(playlist);
    if (songs.some((song) => !songMatchesMode(song.source, mode))) {
      throw new AppError(
        400,
        mode === 'local'
          ? 'This local playlist only accepts local library songs'
          : 'This stream playlist only accepts YouTube / URL songs',
      );
    }

    const added = await appendSongsToPlaylist(prisma, playlistId, ids);
    res.status(201).json({ success: true, added, alreadyInPlaylist: ids.length - added });
  } catch (err) {
    next(err);
  }
});

// POST /:id/songs/from-playlist — Copy matching songs from another playlist
playlistRoutes.post('/:id/songs/from-playlist', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const playlistId = parseInt(req.params.id as string);
    const sourcePlaylistId = parseInt(String(req.body.sourcePlaylistId));
    if (!sourcePlaylistId || Number.isNaN(sourcePlaylistId)) {
      throw new AppError(400, 'sourcePlaylistId is required');
    }
    if (sourcePlaylistId === playlistId) {
      throw new AppError(400, 'Cannot import a playlist into itself');
    }

    const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!playlist) throw new AppError(404, 'Playlist not found');

    const source = await prisma.playlist.findUnique({
      where: { id: sourcePlaylistId },
      include: {
        songs: {
          include: { song: true },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!source) throw new AppError(404, 'Source playlist not found');

    const mode = effectivePlaylistMode(playlist);
    const songIds = source.songs
      .filter((ps: { song: { source: string } }) => songMatchesMode(ps.song.source, mode))
      .map((ps: { song: { id: number } }) => ps.song.id);

    const added = await appendSongsToPlaylist(prisma, playlistId, songIds);
    res.status(201).json({
      success: true,
      added,
      skipped: source.songs.length - songIds.length,
      matched: songIds.length,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/songs/:songId — Remove song from playlist
playlistRoutes.delete('/:id/songs/:songId', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const playlistId = parseInt(req.params.id as string);
    const songId = parseInt(req.params.songId as string);

    await prisma.playlistSong.deleteMany({
      where: { playlistId, songId },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /:id/songs/reorder — Reorder songs
playlistRoutes.put('/:id/songs/reorder', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const playlistId = parseInt(req.params.id as string);
    const { songIds } = req.body;
    if (!Array.isArray(songIds)) throw new AppError(400, 'songIds array is required');

    await prisma.$transaction(
      songIds.map((songId: number, index: number) =>
        prisma.playlistSong.updateMany({
          where: { playlistId, songId },
          data: { position: index },
        }),
      ),
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
