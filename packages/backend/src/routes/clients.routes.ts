import { createHash } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { AppError, TSApiError } from '../middleware/error-handler.js';

export const clientRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId)));
};
const getSid = (req: Request) => parseInt(String(req.params.sid));

interface AvatarCacheEntry {
  data: Buffer;
  contentType: string;
  etag: string;
  verifiedAt: number;
}

const AVATAR_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_AVATARS = 256;
const avatarCache = new Map<string, AvatarCacheEntry>();
const avatarDownloads = new Map<string, Promise<AvatarCacheEntry>>();

function avatarContentType(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new AppError(502, 'TeamSpeak profile avatar is not a supported image');
}

function parseMyTeamSpeakAvatar(rawValue: unknown): URL | null {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;
  const value = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(502, 'TeamSpeak returned an invalid profile avatar URL');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'storage.googleapis.com'
    || url.port !== ''
    || !url.pathname.startsWith('/ts-sys-myts-avatars/')
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new AppError(502, 'TeamSpeak returned an untrusted profile avatar URL');
  }
  return url;
}

async function fetchAvatar(url: URL): Promise<AvatarCacheEntry> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new AppError(502, `TeamSpeak profile avatar returned HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_AVATAR_BYTES) throw new AppError(502, 'TeamSpeak profile avatar is too large');
  if (!response.body) throw new AppError(502, 'TeamSpeak profile avatar returned an empty response');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_AVATAR_BYTES) {
      await reader.cancel();
      throw new AppError(502, 'TeamSpeak profile avatar is too large');
    }
    chunks.push(Buffer.from(value));
  }
  const data = Buffer.concat(chunks, received);
  const contentType = avatarContentType(data);
  const digest = createHash('sha256').update(data).digest('base64url');
  return { data, contentType, etag: `"${digest}"`, verifiedAt: Date.now() };
}

clientRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    // M2: Only include -ip flag for admin users
    const flags: Record<string, string> = {
      '-uid': '', '-away': '', '-voice': '', '-times': '', '-groups': '', '-info': '', '-country': '',
    };
    if (req.user?.role === 'admin') {
      flags['-ip'] = '';
    }
    const result = await getClient(req).execute(getSid(req), 'clientlist', flags, { priority: 'high' });
    res.json(result);
  } catch (err) { next(err); }
});

clientRoutes.get('/database', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'clientdblist', {
      start: req.query.start || 0, duration: req.query.duration || 100,
    });
    res.json(result);
  } catch (err) { next(err); }
});

clientRoutes.get('/database/:cldbid', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'clientdbinfo', { cldbid: String(req.params.cldbid) });
    res.json(result);
  } catch (err) { next(err); }
});

clientRoutes.get('/:clid/avatar', async (req: Request, res: Response, next) => {
  try {
    const clid = Number(req.params.clid);
    if (!Number.isInteger(clid) || clid <= 0) throw new AppError(400, 'A valid connected client ID is required');

    const info = (await getClient(req).execute(getSid(req), 'clientinfo', { clid: String(clid) }))[0] || {};
    const avatarUrl = parseMyTeamSpeakAvatar(info.client_myteamspeak_avatar);
    if (!avatarUrl) throw new AppError(404, 'This client has no TeamSpeak profile avatar');

    const cacheKey = `${req.params.configId}:${getSid(req)}:${info.client_unique_identifier || clid}:${avatarUrl.href}`;
    let entry = avatarCache.get(cacheKey);
    if (!entry || Date.now() - entry.verifiedAt >= AVATAR_CACHE_TTL_MS) {
      let pending = avatarDownloads.get(cacheKey);
      if (!pending) {
        pending = fetchAvatar(avatarUrl).finally(() => avatarDownloads.delete(cacheKey));
        avatarDownloads.set(cacheKey, pending);
      }
      entry = await pending;
      avatarCache.delete(cacheKey);
      avatarCache.set(cacheKey, entry);
      while (avatarCache.size > MAX_CACHED_AVATARS) {
        const oldestKey = avatarCache.keys().next().value;
        if (oldestKey === undefined) break;
        avatarCache.delete(oldestKey);
      }
    }

    res.set({
      'Content-Type': entry.contentType,
      'Content-Length': String(entry.data.length),
      'Cache-Control': 'private, max-age=300, must-revalidate',
      ETag: entry.etag,
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();
    res.send(entry.data);
  } catch (err) { next(err); }
});

clientRoutes.get('/:clid', async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'clientinfo', { clid: String(req.params.clid) });
    res.json(result);
  } catch (err) { next(err); }
});

clientRoutes.post('/:clid/kick', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'clientkick', {
      clid: String(req.params.clid), reasonid: req.body.reasonid || 5, reasonmsg: req.body.reasonmsg,
    });
    res.json(result);
  } catch (err) { next(err); }
});

clientRoutes.post('/:clid/ban', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'banclient', {
      clid: String(req.params.clid), time: req.body.time || 0, banreason: req.body.banreason,
    });
    res.json(result);
  } catch (err) { next(err); }
});

clientRoutes.post('/:clid/move', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'clientmove', {
      clid: String(req.params.clid), cid: req.body.cid, cpw: req.body.cpw,
    });
    res.json(result);
  } catch (err) { next(err); }
});

clientRoutes.post('/:clid/poke', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'clientpoke', {
      clid: String(req.params.clid), msg: req.body.msg,
    });
    res.json(result);
  } catch (err) { next(err); }
});

clientRoutes.post('/:clid/message', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'sendtextmessage', {
      targetmode: 1, target: String(req.params.clid), msg: req.body.msg,
    });
    res.json(result);
  } catch (err) { next(err); }
});

clientRoutes.get('/:cldbid/permissions', async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'clientpermlist', {
      cldbid: String(req.params.cldbid), '-permsid': '',
    });
    res.json(result);
  } catch (err) {
    // TS3 error 1281 = database_empty_result → client has no permissions yet
    if (err instanceof TSApiError && err.code === 1281) {
      res.json([]);
      return;
    }
    next(err);
  }
});

clientRoutes.put('/:cldbid/permissions', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const cldbid = String(req.params.cldbid);
    const { permsid, permvalue, permnegated, permskip } = req.body;
    // Resolve permission name to numeric ID
    const permLookup = await getClient(req).execute(getSid(req), 'permidgetbyname', { permsid });
    const permid = permLookup?.[0]?.permid;
    if (!permid) throw new Error(`Unknown permission: ${permsid}`);
    await getClient(req).executePost(getSid(req), 'clientaddperm', {
      cldbid, permid: String(permid), permvalue: String(permvalue ?? 0),
      permnegated: String(permnegated ?? 0), permskip: String(permskip ?? 0),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

clientRoutes.delete('/:cldbid/permissions', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const cldbid = String(req.params.cldbid);
    const { permsid } = req.body;
    const permLookup = await getClient(req).execute(getSid(req), 'permidgetbyname', { permsid });
    const permid = permLookup?.[0]?.permid;
    if (!permid) throw new Error(`Unknown permission: ${permsid}`);
    await getClient(req).executePost(getSid(req), 'clientdelperm', {
      cldbid, permid: String(permid),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

clientRoutes.get('/:clid/groups', async (req: Request, res: Response, next) => {
  try {
    const result = await getClient(req).execute(getSid(req), 'servergroupsbyclientid', {
      cldbid: String(req.params.clid),
    });
    res.json(result);
  } catch (err) { next(err); }
});
