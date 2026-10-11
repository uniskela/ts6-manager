/**
 * Server icons. TeamSpeak keeps icons in the virtual server's own file storage
 * as `icon_<crc32>`; channels and groups refer to one by that number. These
 * routes list, preview, upload and delete them over the shared SSH query
 * connection plus TeamSpeak's file-transfer port.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import type { ServerIcon, ServerIconList } from '@ts6/common';
import { AppError, TSApiError } from '../middleware/error-handler.js';
import { requireRole } from '../middleware/rbac.js';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';
import { crc32, downloadTransfer, uploadTransfer } from '../utils/ts-file-transfer.js';
import { mapFileMutationError, mapFileSshTransportError, sshExecute } from './files.routes.js';

export const MAX_ICON_BYTES = 256 * 1024;
export const MAX_LISTED_ICONS = 300;
const DEFAULT_TRANSFER_PORT = 30033;
const ICON_FILE = /^icon_(\d{1,10})$/;

export const iconRoutes: Router = Router({ mergeParams: true });

const getConfigId = (req: Request) => parseInt(String(req.params.configId), 10);
const getSid = (req: Request) => parseInt(String(req.params.sid), 10);

/** Icon ids are unsigned CRC32 values; TeamSpeak sometimes reports them signed. */
export function parseIconId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^-?\d{1,10}$/.test(raw)) return null;
  const value = Number(raw);
  if (value < -0x80000000 || value > 0xffffffff) return null;
  const id = value >>> 0;
  return id === 0 ? null : id;
}

export function iconImageMime(image: Buffer): string | null {
  if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (image[0] === 255 && image[1] === 216 && image[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('ascii'))) return 'image/gif';
  return null;
}

/** Icon bytes never change for an id (the id is their checksum), so previews are cached. */
const previewCache = new Map<string, Buffer>();
const PREVIEW_CACHE_MAX = 400;
const cacheKey = (req: Request, id: number) => `${getConfigId(req)}:${getSid(req)}:${id}`;
function cachePreview(key: string, image: Buffer): void {
  if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value as string);
  previewCache.set(key, image);
}

/** One transfer at a time per server so a grid of previews cannot flood the query connection. */
const transferQueues = new Map<string, Promise<unknown>>();
function queued<T>(req: Request, task: () => Promise<T>): Promise<T> {
  const key = `${getConfigId(req)}:${getSid(req)}`;
  const run = (transferQueues.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => undefined);
  transferQueues.set(key, tail);
  void tail.then(() => { if (transferQueues.get(key) === tail) transferQueues.delete(key); });
  return run;
}

async function transferTarget(req: Request, start: Record<string, string> | undefined): Promise<{ host: string; port: number; ftkey: string }> {
  if (start?.status && start.status !== '0') throw new TSApiError(Number(start.status), start.msg || 'file transfer refused');
  if (!start?.ftkey) throw new AppError(502, 'TeamSpeak did not start the icon transfer');
  const server = await req.app.locals.prisma.tsServerConfig.findUnique({ where: { id: getConfigId(req) }, select: { host: true } });
  if (!server?.host) throw new AppError(404, 'Server connection not found');
  return { host: server.host, port: Number(start.port) || DEFAULT_TRANSFER_PORT, ftkey: start.ftkey };
}

const transferId = () => String(Math.floor(Math.random() * 65534) + 1);

function mapIconError(err: unknown, purpose: 'browse' | 'changes', req: Request): unknown {
  if (purpose === 'changes') return mapFileMutationError(err, 'managing icons', req);
  return (err instanceof Error && mapFileSshTransportError(err, 'browse')) || err;
}

// GET .../icons — icons stored on this virtual server.
iconRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    let rows: Record<string, string>[] = [];
    try {
      rows = await sshExecute(req, 'ftgetfilelist', { cid: '0', cpw: '', path: '/icons' });
    } catch (err) {
      // 1281 = empty result: no icons uploaded yet.
      if (!(err instanceof TSApiError && err.code === 1281)) throw err;
    }
    const icons: ServerIcon[] = [];
    for (const row of rows) {
      const match = ICON_FILE.exec(row.name ?? '');
      const id = match ? parseIconId(match[1]) : null;
      if (id !== null) icons.push({ id, size: Number(row.size) || 0, uploadedAt: Number(row.datetime) ? new Date(Number(row.datetime) * 1000).toISOString() : null });
    }
    icons.sort((a, b) => (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? '') || a.id - b.id);
    const body: ServerIconList = { maxBytes: MAX_ICON_BYTES, truncated: icons.length > MAX_LISTED_ICONS, icons: icons.slice(0, MAX_LISTED_ICONS) };
    res.json(body);
  } catch (err) { next(mapIconError(err, 'browse', req)); }
});

// GET .../icons/:id — the icon image, for previews.
iconRoutes.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const id = parseIconId(String(req.params.id));
    if (id === null) throw new AppError(404, 'Icon not found');
    const key = cacheKey(req, id);
    let image = previewCache.get(key);
    if (!image) {
      image = await queued(req, async () => {
        const cached = previewCache.get(key);
        if (cached) return cached;
        const [start] = await sshExecute(req, 'ftinitdownload', { clientftfid: transferId(), name: `/icon_${id}`, cid: '0', cpw: '', seekpos: '0' });
        const target = await transferTarget(req, start);
        const size = Number(start.size);
        if (!Number.isInteger(size) || size <= 0 || size > MAX_ICON_BYTES) throw new AppError(404, 'Icon not found');
        return downloadTransfer(target.host, target.port, target.ftkey, size);
      });
      cachePreview(key, image);
    }
    const mime = iconImageMime(image);
    if (!mime) throw new AppError(415, 'This icon is not a PNG, JPEG or GIF image');
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(mime).send(image);
  } catch (err) {
    // 2051 / 781-style "file not found" replies mean the icon is gone.
    if (err instanceof TSApiError && /not found|invalid file/i.test(err.message)) return next(new AppError(404, 'Icon not found'));
    next(mapIconError(err, 'browse', req));
  }
});

const iconUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ICON_BYTES, files: 1, fields: 0 } }).single('file');
const UPLOAD_HINT = 'Upload exactly one PNG, JPEG or GIF image';

// POST .../icons — upload one image (multipart field `file`); responds with its icon id.
iconRoutes.post('/', requireRole('admin'), (req, res, next) => {
  iconUpload(req, res, (error) => {
    if (error) return next(new AppError(400, error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? `Icon must be at most ${MAX_ICON_BYTES / 1024} KB` : UPLOAD_HINT));
    next();
  });
}, async (req: Request, res: Response, next) => {
  try {
    const image = req.file?.buffer;
    if (!image || image.length === 0) throw new AppError(400, UPLOAD_HINT);
    if (!iconImageMime(image)) throw new AppError(400, 'Icon must be a PNG, JPEG or GIF image');
    const id = crc32(image);
    if (id === 0) throw new AppError(400, 'This image cannot be used as an icon');
    const sid = getSid(req);
    await runRemoteAudited(req.app.locals.prisma, {
      actor: actorFromRequest(req.user), action: 'server_icon.upload', connectionId: getConfigId(req), virtualServerId: sid,
      target: { type: 'server_icon', id: String(id) },
    }, () => queued(req, async () => {
      const [start] = await sshExecute(req, 'ftinitupload', {
        clientftfid: transferId(), name: `/icon_${id}`, cid: '0', cpw: '', size: String(image.length), overwrite: '1', resume: '0',
      });
      const target = await transferTarget(req, start);
      await uploadTransfer(target.host, target.port, target.ftkey, image);
    }));
    cachePreview(cacheKey(req, id), image);
    const body: ServerIcon = { id, size: image.length, uploadedAt: new Date().toISOString() };
    res.status(201).json(body);
  } catch (err) { next(mapIconError(err, 'changes', req)); }
});

// DELETE .../icons/:id — channels and groups still using it show no icon.
iconRoutes.delete('/:id', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const id = parseIconId(String(req.params.id));
    if (id === null) throw new AppError(404, 'Icon not found');
    const sid = getSid(req);
    await runRemoteAudited(req.app.locals.prisma, {
      actor: actorFromRequest(req.user), action: 'server_icon.delete', connectionId: getConfigId(req), virtualServerId: sid,
      target: { type: 'server_icon', id: String(id) },
    }, () => sshExecute(req, 'ftdeletefile', { cid: '0', cpw: '', name: `/icon_${id}` }));
    previewCache.delete(cacheKey(req, id));
    res.json({ success: true });
  } catch (err) { next(mapIconError(err, 'changes', req)); }
});
