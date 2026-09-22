import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import {
  refreshPlaylist,
  createUploadedPlaylist,
  replaceUploadedPlaylist,
  deletePlaylistWithSource,
  toPlaylistSummary,
} from '../iptv/iptv-service.js';
import { MAX_IPTV_UPLOAD_BYTES } from '../iptv/iptv-storage.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';

export const iptvRoutes: Router = Router();

iptvRoutes.use(requireRole('admin'));

const playlistUpload = multer({
  limits: { fileSize: MAX_IPTV_UPLOAD_BYTES },
  storage: multer.memoryStorage(),
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many IPTV upload requests, please try again later' },
});

function multerUpload(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    playlistUpload.single(field)(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError(400, `Playlist exceeds ${MAX_IPTV_UPLOAD_BYTES} byte limit`));
        }
        return next(new AppError(400, err.message));
      }
      return next(err);
    });
  };
}

// GET /playlists?serverConfigId= — list playlists (optionally for one server)
iptvRoutes.get('/playlists', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const serverConfigId = req.query.serverConfigId ? parseInt(req.query.serverConfigId as string) : undefined;
    const playlists = await prisma.iptvPlaylist.findMany({
      where: serverConfigId ? { serverConfigId } : undefined,
      include: { _count: { select: { channels: true } } },
      orderBy: { id: 'asc' },
    });
    res.json(playlists.map((p: any) => toPlaylistSummary(p)));
  } catch (err) { next(err); }
});

// POST /playlists — create a URL playlist and do an initial refresh
iptvRoutes.post('/playlists', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, url, serverConfigId, autoRefreshMinutes } = req.body;
    if (!name || !url || !serverConfigId) throw new AppError(400, 'name, url and serverConfigId are required');

    const playlist = await prisma.iptvPlaylist.create({
      data: {
        name,
        sourceType: 'url',
        url,
        sourcePath: null,
        originalFilename: null,
        serverConfigId: parseInt(serverConfigId),
        autoRefreshMinutes: autoRefreshMinutes != null ? parseInt(autoRefreshMinutes) : 0,
      },
    });

    let channelCount = 0;
    let refreshError: string | null = null;
    try {
      ({ channelCount } = await refreshPlaylist(prisma, playlist.id));
    } catch (err: any) {
      refreshError = err?.message ?? 'Refresh failed';
    }

    res.status(201).json({ id: playlist.id, channelCount, refreshError, sourceType: 'url' });
  } catch (err) { next(err); }
});

// POST /playlists/upload — create playlist from uploaded M3U/M3U8/txt file
iptvRoutes.post(
  '/playlists/upload',
  uploadLimiter,
  multerUpload('playlist'),
  async (req: Request, res: Response, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const serverConfigId = parseInt(req.body?.serverConfigId);
      if (!name || !Number.isFinite(serverConfigId)) {
        throw new AppError(400, 'name and serverConfigId are required');
      }
      if (!req.file) throw new AppError(400, 'playlist file is required');

      const result = await createUploadedPlaylist(prisma, {
        name,
        serverConfigId,
        fileBuffer: req.file.buffer,
        originalFilename: req.file.originalname,
      });

      res.status(201).json({ ...result, refreshError: null, sourceType: 'upload' });
    } catch (err: any) {
      if (err instanceof AppError) return next(err);
      const message = String(err?.message ?? err);
      if (
        message.includes('empty')
        || message.includes('no valid channels')
        || message.includes('does not look like')
        || message.includes('byte limit')
      ) {
        return next(new AppError(400, message));
      }
      next(err);
    }
  },
);

// POST /playlists/:id/replace — replace uploaded source file and re-parse
iptvRoutes.post(
  '/playlists/:id/replace',
  uploadLimiter,
  multerUpload('playlist'),
  async (req: Request, res: Response, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const id = parseInt(req.params.id as string);
      if (!Number.isFinite(id)) throw new AppError(400, 'Invalid playlist id');
      if (!req.file) throw new AppError(400, 'playlist file is required');

      const result = await replaceUploadedPlaylist(prisma, {
        playlistId: id,
        fileBuffer: req.file.buffer,
        originalFilename: req.file.originalname,
      });
      res.json({ success: true, ...result });
    } catch (err: any) {
      if (err instanceof AppError) return next(err);
      const message = String(err?.message ?? err);
      if (
        message.includes('empty')
        || message.includes('no valid channels')
        || message.includes('does not look like')
        || message.includes('byte limit')
        || message.includes('Only uploaded')
        || message.includes('not found')
      ) {
        const status = message.includes('not found') ? 404 : 400;
        return next(new AppError(status, message));
      }
      next(err);
    }
  },
);

// PUT /playlists/:id — update playlist metadata
iptvRoutes.put('/playlists/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(req.params.id as string);
    const existing = await prisma.iptvPlaylist.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'Playlist not found');

    const { name, url, autoRefreshMinutes } = req.body;
    const sourceType = existing.sourceType || 'url';
    const data: Record<string, unknown> = {};
    if (name != null) data.name = name;
    if (autoRefreshMinutes != null) data.autoRefreshMinutes = parseInt(autoRefreshMinutes);
    // URL updates only apply to URL sources — never invent file:// for uploads.
    if (url != null && sourceType === 'url') data.url = url;

    await prisma.iptvPlaylist.update({ where: { id }, data });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /playlists/:id
iptvRoutes.delete('/playlists/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await deletePlaylistWithSource(prisma, parseInt(req.params.id as string));
    res.json({ success: true });
  } catch (err: any) {
    if (String(err?.message ?? err).includes('not found')) {
      return next(new AppError(404, 'Playlist not found'));
    }
    next(err);
  }
});

// POST /playlists/:id/refresh — re-fetch (URL) or re-parse stored file (upload)
iptvRoutes.post('/playlists/:id/refresh', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const result = await refreshPlaylist(prisma, parseInt(req.params.id as string));
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// GET /playlists/:id/groups — distinct group titles (for filtering)
iptvRoutes.get('/playlists/:id/groups', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const playlistId = parseInt(req.params.id as string);
    const rows = await prisma.iptvChannel.findMany({
      where: { playlistId, groupTitle: { not: null } },
      distinct: ['groupTitle'],
      select: { groupTitle: true },
      orderBy: { groupTitle: 'asc' },
    });
    res.json(rows.map((r: any) => r.groupTitle).filter(Boolean));
  } catch (err) { next(err); }
});

// GET /playlists/:id/channels?search=&group=&page=&pageSize= — paginated channels
iptvRoutes.get('/playlists/:id/channels', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const playlistId = parseInt(req.params.id as string);
    const search = (req.query.search as string || '').trim();
    const group = (req.query.group as string || '').trim();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 50));

    const where: any = { playlistId };
    if (search) where.name = { contains: search };
    if (group) where.groupTitle = group;

    const [total, channels] = await Promise.all([
      prisma.iptvChannel.count({ where }),
      prisma.iptvChannel.findMany({
        where,
        orderBy: { position: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ total, page, pageSize, channels });
  } catch (err) { next(err); }
});

// POST /stream — stream a channel to a connected music bot via the video sidecar.
// Body: { botId, channelId, preset? }
iptvRoutes.post('/stream', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const { botId, channelId, preset } = req.body;
    if (!botId || !channelId) throw new AppError(400, 'botId and channelId are required');

    const channel = await prisma.iptvChannel.findUnique({ where: { id: parseInt(channelId) } });
    if (!channel) throw new AppError(404, 'Channel not found');

    const bot = manager.getBot(parseInt(botId));
    if (!bot) throw new AppError(404, 'Music bot not found or not running');

    // If already streaming, just switch the source; otherwise start a stream.
    if (bot.videoStreaming) {
      await bot.setVideoSource(channel.url);
    } else {
      await bot.startVideoStream(channel.url, preset);
    }

    res.json({ success: true, channel: { id: channel.id, name: channel.name } });
  } catch (err) { next(err); }
});

// POST /stop — stop a bot's video stream
iptvRoutes.post('/stop', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const { botId } = req.body;
    if (!botId) throw new AppError(400, 'botId is required');
    const bot = manager.getBot(parseInt(botId));
    if (!bot) throw new AppError(404, 'Music bot not found or not running');
    await bot.stopVideoStream();
    res.json({ success: true });
  } catch (err) { next(err); }
});
