/**
 * Settings routes — app-wide configuration (admin only, except reading the
 * video streaming defaults).
 * Handles yt-dlp cookies, app limits, video streaming defaults, and
 * demand-driven runtime/media diagnostics.
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { AppError } from '../middleware/error-handler.js';
import { setYtCookieFile, getYtCookieFile } from '../voice/audio/youtube.js';
import {
  MAX_VIDEO_DURATION_KEY,
  MAX_PLAYLIST_IMPORT_KEY,
  parseVideoDuration,
  parseImportCap,
  loadVideoStreamingSettings,
  loadServerVideoStreamingSettings,
  parseServerOverrides,
  parseVideoStreamingUpdate,
  videoServerOverridesKey,
  IPTV_LOCAL_HOSTS_KEY,
  loadIptvLocalHosts,
  parseIptvLocalHostsUpdate,
} from '../utils/app-settings.js';
import { SidecarClient } from '../voice/streaming/sidecar-client.js';
import { actorFromRequest, recordLocalSuccess, runRemoteAudited } from '../audit/index.js';
import { diagnoseRuntimeMedia } from '../voice/audio/runtime-media-diagnostics.js';

const settingsRoutes: Router = Router();

// Cookie file stored in the backend data directory (persisted in Docker volume)
const COOKIE_DIR = path.resolve('data');
const COOKIE_PATH = path.join(COOKIE_DIR, 'yt-cookies.txt');

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  storage: multer.memoryStorage(),
});

const ytCookiesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many cookie settings requests, please try again later' },
});

const runtimeDiagnosticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many runtime diagnostic requests, please try again later' },
});

// Admin-only guard
function requireAdmin(req: Request, _res: Response, next: Function) {
  if ((req as any).user?.role !== 'admin') {
    return next(new AppError(403, 'Admin access required'));
  }
  next();
}

// GET /api/settings/yt-cookies — Check cookie file status
settingsRoutes.get('/yt-cookies', requireAdmin, ytCookiesLimiter, (_req: Request, res: Response) => {
  const exists = fs.existsSync(COOKIE_PATH);
  const activePath = getYtCookieFile();
  res.json({
    active: !!activePath,
    exists,
    size: exists ? fs.statSync(COOKIE_PATH).size : 0,
    path: activePath,
  });
});

// POST /api/settings/yt-cookies — Upload cookie file
settingsRoutes.post('/yt-cookies', requireAdmin, ytCookiesLimiter, upload.single('cookies'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Fail-closed pending audit before writing cookie material; never store cookie contents.
    const size = await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'settings.yt_cookies_changed',
        target: { type: 'settings', id: 'yt-cookies' },
      },
      async () => {
        if (!req.file) {
          const text = req.body?.text;
          if (!text || typeof text !== 'string') {
            throw new AppError(400, 'No cookie file or text provided');
          }
          fs.mkdirSync(COOKIE_DIR, { recursive: true });
          fs.writeFileSync(COOKIE_PATH, text, 'utf-8');
        } else {
          fs.mkdirSync(COOKIE_DIR, { recursive: true });
          fs.writeFileSync(COOKIE_PATH, req.file.buffer);
        }
        setYtCookieFile(COOKIE_PATH);
        return fs.statSync(COOKIE_PATH).size;
      },
    );
    console.log(`[yt-dlp] Cookie file uploaded (${size} bytes)`);
    res.json({ success: true, size });
  } catch (err) { next(err); }
});

// DELETE /api/settings/yt-cookies — Remove cookie file
settingsRoutes.delete('/yt-cookies', requireAdmin, ytCookiesLimiter, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await runRemoteAudited(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'settings.yt_cookies_removed',
        target: { type: 'settings', id: 'yt-cookies' },
      },
      async () => {
        if (fs.existsSync(COOKIE_PATH)) {
          fs.unlinkSync(COOKIE_PATH);
        }
        setYtCookieFile(null);
      },
    );
    console.log('[yt-dlp] Cookie file removed');
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * GET /api/settings/runtime-diagnostics — bounded yt-dlp/ffmpeg/ffprobe/sidecar probes.
 * Demand-driven only (UI page entry / manual refresh). Not called from /api/health
 * or music-bot status polling.
 */
settingsRoutes.get(
  '/runtime-diagnostics',
  requireAdmin,
  runtimeDiagnosticsLimiter,
  async (_req: Request, res: Response, next) => {
    try {
      const report = await diagnoseRuntimeMedia();
      res.json(report);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/settings/limits — App-wide numeric limits
settingsRoutes.get('/limits', requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rows = await prisma.appSetting.findMany({
      where: { key: { in: [MAX_VIDEO_DURATION_KEY, MAX_PLAYLIST_IMPORT_KEY] } },
    });
    const map = new Map(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
    res.json({
      maxVideoDuration: parseVideoDuration(map.get(MAX_VIDEO_DURATION_KEY) as string | undefined),
      maxPlaylistImport: parseImportCap(map.get(MAX_PLAYLIST_IMPORT_KEY) as string | undefined),
    });
  } catch (err) { next(err); }
});

// PUT /api/settings/limits — Update app-wide numeric limits
settingsRoutes.put('/limits', requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { maxVideoDuration, maxPlaylistImport } = req.body;

    if (maxVideoDuration == null && maxPlaylistImport == null) {
      throw new AppError(400, 'Provide maxVideoDuration and/or maxPlaylistImport');
    }

    await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'settings.limits_update',
        target: { type: 'settings', id: 'limits' },
      },
      async (tx) => {
        if (maxVideoDuration != null) {
          const val = parseVideoDuration(String(maxVideoDuration), -1);
          if (val < 0) throw new AppError(400, 'maxVideoDuration must be a non-negative integer (seconds)');
          await tx.appSetting.upsert({
            where: { key: MAX_VIDEO_DURATION_KEY },
            create: { key: MAX_VIDEO_DURATION_KEY, value: String(val) },
            update: { value: String(val) },
          });
        }

        if (maxPlaylistImport != null) {
          const val = parseImportCap(String(maxPlaylistImport), -1);
          if (val <= 0) throw new AppError(400, 'maxPlaylistImport must be a positive integer (max 500)');
          await tx.appSetting.upsert({
            where: { key: MAX_PLAYLIST_IMPORT_KEY },
            create: { key: MAX_PLAYLIST_IMPORT_KEY, value: String(val) },
            update: { value: String(val) },
          });
        }
      },
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/settings/video-streaming — defaults applied to new video streams.
// Readable by any signed-in user so stream controls can describe them.
settingsRoutes.get('/video-streaming', async (req: Request, res: Response, next) => {
  try {
    res.json(await loadVideoStreamingSettings(req.app.locals.prisma));
  } catch (err) { next(err); }
});

// PUT /api/settings/video-streaming — update streaming defaults (next stream start).
settingsRoutes.put('/video-streaming', requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const parsed = parseVideoStreamingUpdate(req.body);
    if (!parsed.ok) throw new AppError(400, parsed.error);

    await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'settings.video_streaming_update',
        target: { type: 'settings', id: 'video-streaming' },
      },
      async (tx) => {
        for (const row of parsed.rows) {
          await tx.appSetting.upsert({
            where: { key: row.key },
            create: row,
            update: { value: row.value },
          });
        }
      },
    );

    res.json(await loadVideoStreamingSettings(prisma));
  } catch (err) { next(err); }
});

// GET /api/settings/iptv-network — LAN hosts allowed for admin-configured IPTV sources.
settingsRoutes.get('/iptv-network', requireAdmin, async (req: Request, res: Response, next) => {
  try {
    res.json({ allowedLocalHosts: await loadIptvLocalHosts(req.app.locals.prisma) });
  } catch (err) { next(err); }
});

// PUT /api/settings/iptv-network — replace the allowed local IPTV hosts.
settingsRoutes.put('/iptv-network', requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const parsed = parseIptvLocalHostsUpdate(req.body);
    if (!parsed.ok) throw new AppError(400, parsed.error);
    const value = JSON.stringify(parsed.value);
    await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'settings.iptv_network_update',
        target: { type: 'settings', id: 'iptv-network' },
      },
      (tx) => tx.appSetting.upsert({
        where: { key: IPTV_LOCAL_HOSTS_KEY },
        create: { key: IPTV_LOCAL_HOSTS_KEY, value },
        update: { value },
      }),
    );
    res.json({ allowedLocalHosts: parsed.value });
  } catch (err) { next(err); }
});

function parseServerId(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'Invalid server id');
  return id;
}

// GET /api/settings/video-streaming/servers/:serverConfigId — global, overrides, effective.
settingsRoutes.get('/video-streaming/servers/:serverConfigId', async (req: Request, res: Response, next) => {
  try {
    const id = parseServerId(req.params.serverConfigId);
    res.json(await loadServerVideoStreamingSettings(req.app.locals.prisma, id));
  } catch (err) { next(err); }
});

// PUT /api/settings/video-streaming/servers/:serverConfigId — replace this server's
// overrides. Fields equal to the global default are not stored (they inherit).
settingsRoutes.put('/video-streaming/servers/:serverConfigId', requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseServerId(req.params.serverConfigId);
    const server = await prisma.tsServerConfig.findUnique({ where: { id }, select: { id: true } });
    if (!server) throw new AppError(404, 'Server not found');

    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const [field, value] of Object.entries(body)) {
      const check = parseVideoStreamingUpdate({ [field]: value });
      if (!check.ok) throw new AppError(400, check.error);
    }
    const { global } = await loadServerVideoStreamingSettings(prisma, id);
    const submitted = parseServerOverrides(body);
    const overrides = Object.fromEntries(
      Object.entries(submitted).filter(([k, v]) => (global as unknown as Record<string, unknown>)[k] !== v),
    );
    const key = videoServerOverridesKey(id);

    await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'settings.video_streaming_update',
        connectionId: id,
        target: { type: 'settings', id: 'video-streaming:server' },
      },
      async (tx) => {
        if (Object.keys(overrides).length === 0) {
          await tx.appSetting.deleteMany({ where: { key } });
        } else {
          const value = JSON.stringify(overrides);
          await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
        }
      },
    );

    res.json(await loadServerVideoStreamingSettings(prisma, id));
  } catch (err) { next(err); }
});

/**
 * GET /api/settings/video-encoders — encoder capabilities from the sidecar.
 * The sidecar caches its test encodes; `?refresh=1` re-runs them. On demand only.
 */
settingsRoutes.get(
  '/video-encoders',
  requireAdmin,
  runtimeDiagnosticsLimiter,
  async (req: Request, res: Response, next) => {
    try {
      const url = (process.env.SIDECAR_URL || '').trim();
      const client = new SidecarClient(url || Number(process.env.SIDECAR_PORT) || 9800);
      try {
        res.json(await client.getEncoders(req.query.refresh === '1'));
      } catch {
        throw new AppError(
          503,
          url
            ? 'Media sidecar did not answer — check SIDECAR_URL/SIDECAR_SECRET and that the sidecar image is up to date'
            : 'Media sidecar is not running — it starts with a video stream, or set SIDECAR_URL',
        );
      }
    } catch (err) { next(err); }
  },
);

export { settingsRoutes };
