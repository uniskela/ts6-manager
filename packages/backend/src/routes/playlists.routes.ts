import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';

export const playlistRoutes: Router = Router();

playlistRoutes.use(requireRole('admin'));

type PlaylistMode = 'local' | 'stream';

function normalizePlaylistMode(raw: unknown, fallback: PlaylistMode = 'local'): PlaylistMode {
  if (raw === 'stream' || raw === 'local') return raw;
  return fallback;
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
    const musicBotId = req.query.musicBotId ? parseInt(String(req.query.musicBotId)) : undefined;
    const playlists = await prisma.playlist.findMany({
      where: musicBotId ? { musicBotId } : undefined,
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
    const { name, musicBotId, mode } = req.body;
    if (!name) throw new AppError(400, 'name is required');
    const playlistMode = normalizePlaylistMode(mode, 'local');

    const playlist = await prisma.playlist.create({
      data: {
        name,
        mode: playlistMode,
        musicBotId: musicBotId ? parseInt(musicBotId) : null,
      },
    });

    res.status(201).json({
      id: playlist.id,
      name: playlist.name,
      mode: normalizePlaylistMode(playlist.mode),
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
    const { name, musicBotId, mode } = req.body;

    const data: Record<string, unknown> = {};
    if (name != null) data.name = name;
    if (musicBotId !== undefined) data.musicBotId = musicBotId ? parseInt(musicBotId) : null;
    if (mode !== undefined) data.mode = normalizePlaylistMode(mode);

    await prisma.playlist.update({ where: { id }, data });

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

async function appendSongsToPlaylist(
  prisma: any,
  playlistId: number,
  songIds: number[],
): Promise<number> {
  const maxPos = await prisma.playlistSong.aggregate({
    where: { playlistId },
    _max: { position: true },
  });
  let nextPosition = (maxPos._max.position ?? -1) + 1;
  let added = 0;

  for (const songId of songIds) {
    const existing = await prisma.playlistSong.findUnique({
      where: { playlistId_songId: { playlistId, songId } },
    });
    if (existing) continue;
    await prisma.playlistSong.create({
      data: { playlistId, songId, position: nextPosition },
    });
    nextPosition++;
    added++;
  }
  return added;
}

// POST /:id/songs — Add song to playlist
playlistRoutes.post('/:id/songs', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const playlistId = parseInt(req.params.id as string);
    const { songId } = req.body;
    if (!songId) throw new AppError(400, 'songId is required');

    const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!playlist) throw new AppError(404, 'Playlist not found');

    const song = await prisma.song.findUnique({ where: { id: parseInt(songId) } });
    if (!song) throw new AppError(404, 'Song not found');

    const mode = effectivePlaylistMode(playlist);
    if (!songMatchesMode(song.source, mode)) {
      throw new AppError(
        400,
        mode === 'local'
          ? 'This local playlist only accepts local library songs'
          : 'This stream playlist only accepts YouTube / URL songs',
      );
    }

    const added = await appendSongsToPlaylist(prisma, playlistId, [song.id]);
    res.status(201).json({ success: true, added });
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
