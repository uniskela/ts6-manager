/**
 * Settings routes — app-wide configuration (admin only).
 * Handles yt-dlp cookies, app limits, and demand-driven runtime/media diagnostics.
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
} from '../utils/app-settings.js';
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

export { settingsRoutes };
