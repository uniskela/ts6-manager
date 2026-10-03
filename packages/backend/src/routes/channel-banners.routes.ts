/**
 * Hosted channel banners. Admins upload images here and use the public link as
 * a TS6 channel's banner image URL; TeamSpeak clients fetch the image without
 * signing in, so the public route serves only server-generated file names.
 */

import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import type { ChannelBannerList, HostedChannelBanner } from '@ts6/common';
import { AppError } from '../middleware/error-handler.js';
import { requireRole } from '../middleware/rbac.js';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';
import { loadPublicUrl } from '../utils/app-settings.js';
import {
  MAX_BANNER_BYTES,
  MAX_BANNERS,
  bannerImageType,
  bannerMime,
  deleteChannelBanner,
  hasChannelBanner,
  isBannerName,
  listChannelBanners,
  readChannelBanner,
  saveChannelBanner,
  type StoredBanner,
} from '../utils/channel-banner-storage.js';

export const BANNER_PUBLIC_PATH = '/api/banners';

function describe(banner: StoredBanner, publicUrl: string | null): HostedChannelBanner {
  const bannerPath = `${BANNER_PUBLIC_PATH}/${banner.name}`;
  return { ...banner, path: bannerPath, url: publicUrl ? `${publicUrl}${bannerPath}` : null };
}

const bannerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BANNER_BYTES, files: 1, fields: 0 } }).single('file');

export const channelBannerRoutes: Router = Router();
channelBannerRoutes.use(requireRole('admin'));

// GET /api/channel-banners — hosted banners with their public links.
channelBannerRoutes.get('/', async (req, res, next) => {
  try {
    const { publicUrl, source } = await loadPublicUrl(req.app.locals.prisma);
    const banners = await listChannelBanners();
    const body: ChannelBannerList = {
      publicUrl,
      publicUrlSource: source,
      maxBytes: MAX_BANNER_BYTES,
      maxCount: MAX_BANNERS,
      banners: banners.map((b) => describe(b, publicUrl)),
    };
    res.json(body);
  } catch (err) { next(err); }
});

// POST /api/channel-banners — upload one image (multipart field `file`).
channelBannerRoutes.post('/', (req, res, next) => {
  bannerUpload(req, res, (error) => {
    if (error) return next(new AppError(400, error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'Banner must be at most 5 MB' : 'Upload exactly one PNG, JPEG, GIF or WebP image'));
    next();
  });
}, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'Upload exactly one PNG, JPEG, GIF or WebP image');
    bannerImageType(req.file.buffer);
    const prisma = req.app.locals.prisma;
    const saved = await runRemoteAudited(prisma, {
      actor: actorFromRequest(req.user), action: 'channel_banner.upload', target: { type: 'channel_banner' },
    }, () => saveChannelBanner(req.file!.buffer), { resolveTargetId: (banner) => banner.name });
    const { publicUrl } = await loadPublicUrl(prisma);
    res.status(201).json(describe(saved, publicUrl));
  } catch (err) { next(err); }
});

// DELETE /api/channel-banners/:name — channels still pointing at it show no banner.
channelBannerRoutes.delete('/:name', async (req, res, next) => {
  try {
    const name = String(req.params.name);
    if (!(await hasChannelBanner(name))) throw new AppError(404, 'Banner not found');
    await runRemoteAudited(req.app.locals.prisma, {
      actor: actorFromRequest(req.user), action: 'channel_banner.delete', target: { type: 'channel_banner', id: name },
    }, async () => {
      if (!(await deleteChannelBanner(name))) throw new AppError(404, 'Banner not found');
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

const publicBannerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many banner requests, please try again later' },
});

export const channelBannerPublicRoutes: Router = Router();

// GET /api/banners/:name — unauthenticated image for TeamSpeak clients.
channelBannerPublicRoutes.get('/:name', publicBannerLimiter, async (req, res, next) => {
  try {
    const name = String(req.params.name);
    const image = isBannerName(name) ? await readChannelBanner(name) : null;
    if (!image) {
      res.setHeader('Cache-Control', 'no-store');
      throw new AppError(404, 'Banner not found');
    }
    // Names are random and never reused, so the bytes behind a link never change.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(bannerMime(name)).send(image);
  } catch (err) { next(err); }
});
