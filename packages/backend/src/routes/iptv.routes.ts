import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { refreshPlaylist } from '../iptv/iptv-service.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';

export const iptvRoutes: Router = Router();

iptvRoutes.use(requireRole('admin'));

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
    res.json(playlists.map((p: any) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      serverConfigId: p.serverConfigId,
      autoRefreshMinutes: p.autoRefreshMinutes,
      lastRefreshedAt: p.lastRefreshedAt,
      lastError: p.lastError,
      channelCount: p._count.channels,
      createdAt: p.createdAt,
    })));
  } catch (err) { next(err); }
});

// POST /playlists — create a playlist and do an initial refresh
iptvRoutes.post('/playlists', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, url, serverConfigId, autoRefreshMinutes } = req.body;
    if (!name || !url || !serverConfigId) throw new AppError(400, 'name, url and serverConfigId are required');

    const playlist = await prisma.iptvPlaylist.create({
      data: {
        name,
        url,
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

    res.status(201).json({ id: playlist.id, channelCount, refreshError });
  } catch (err) { next(err); }
});

// PUT /playlists/:id — update playlist metadata
iptvRoutes.put('/playlists/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(req.params.id as string);
    const { name, url, autoRefreshMinutes } = req.body;
    await prisma.iptvPlaylist.update({
      where: { id },
      data: {
        ...(name != null && { name }),
        ...(url != null && { url }),
        ...(autoRefreshMinutes != null && { autoRefreshMinutes: parseInt(autoRefreshMinutes) }),
      },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /playlists/:id
iptvRoutes.delete('/playlists/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.iptvPlaylist.delete({ where: { id: parseInt(req.params.id as string) } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /playlists/:id/refresh — re-fetch and re-parse
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
