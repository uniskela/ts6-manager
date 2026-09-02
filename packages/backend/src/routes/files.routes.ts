import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError, TSApiError } from '../middleware/error-handler.js';
import { parseQueryResponse, tsEscape } from '@ts6/common';
import type { BotEngine } from '../bot-engine/engine.js';

export const fileRoutes: Router = Router({ mergeParams: true });

const getConfigId = (req: Request) => parseInt(String(req.params.configId));
const getSid = (req: Request) => parseInt(String(req.params.sid));

interface ChannelFileSummary {
  cid: number;
  fileCount: number;
  folderCount: number;
  totalSize: number;
  scannedAt: number;
}

const FILE_SUMMARY_TTL_MS = 30_000;
const MAX_SUMMARY_DEPTH = 32;
const MAX_SUMMARY_ENTRIES = 10_000;
const fileSummaryCache = new Map<string, ChannelFileSummary>();
const fileSummaryScans = new Map<string, Promise<ChannelFileSummary>>();

const fileSummaryKey = (req: Request, cid: number) => `${getConfigId(req)}:${getSid(req)}:${cid}`;

async function listChannelPath(req: Request, cid: number, path: string): Promise<Record<string, string>[]> {
  try {
    return await sshExecute(req, 'ftgetfilelist', { cid: String(cid), cpw: '', path });
  } catch (err) {
    if (err instanceof TSApiError && err.code === 1281) return [];
    throw err;
  }
}

async function scanChannelFiles(req: Request, cid: number): Promise<ChannelFileSummary> {
  let fileCount = 0;
  let folderCount = 0;
  let totalSize = 0;
  let entryCount = 0;
  const visited = new Set<string>();

  const scan = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_SUMMARY_DEPTH) throw new AppError(422, 'Channel file tree exceeds the supported depth');
    if (visited.has(path)) return;
    visited.add(path);

    const entries = await listChannelPath(req, cid, path);
    for (const entry of entries) {
      const name = String(entry.name || '');
      if (!name || name === '.' || name === '..') continue;
      entryCount += 1;
      if (entryCount > MAX_SUMMARY_ENTRIES) throw new AppError(422, 'Channel file tree contains too many entries');

      // ftgetfilelist: type 0 = file, 1 = directory (matches Files browser)
      if (String(entry.type) === '1') {
        folderCount += 1;
        const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
        await scan(childPath, depth + 1);
      } else if (String(entry.type) === '0') {
        fileCount += 1;
        const size = Number(entry.size);
        if (Number.isFinite(size) && size > 0) totalSize += size;
      }
    }
  };

  await scan('/', 0);
  return { cid, fileCount, folderCount, totalSize, scannedAt: Date.now() };
}

async function getChannelFileSummary(req: Request, cid: number): Promise<ChannelFileSummary> {
  const key = fileSummaryKey(req, cid);
  const cached = fileSummaryCache.get(key);
  if (cached && Date.now() - cached.scannedAt < FILE_SUMMARY_TTL_MS) return cached;

  let pending = fileSummaryScans.get(key);
  if (!pending) {
    pending = scanChannelFiles(req, cid).finally(() => fileSummaryScans.delete(key));
    fileSummaryScans.set(key, pending);
  }
  const summary = await pending;
  fileSummaryCache.set(key, summary);
  return summary;
}

/**
 * Execute a ServerQuery command via the shared SSH connection (EventBridge).
 * Reuses the same SSH session used for bot events — no extra server slots.
 */
async function sshExecute(
  req: Request,
  command: string,
  params: Record<string, string>,
): Promise<Record<string, string>[]> {
  const engine: BotEngine = req.app.locals.botEngine;
  if (!engine) throw new AppError(503, 'Bot engine not available');

  const bridge = engine.getEventBridge();
  const configId = getConfigId(req);
  const sid = getSid(req);

  // Build raw ServerQuery command string
  const paramStr = Object.entries(params)
    .map(([k, v]) => `${k}=${tsEscape(v)}`)
    .join(' ');
  const fullCommand = paramStr ? `${command} ${paramStr}` : command;

  let rawResponse: string;
  try {
    rawResponse = await bridge.executeCommand(configId, sid, fullCommand);
  } catch (err: any) {
    // Convert "TS error {code}: {msg}" to TSApiError
    const match = err.message?.match(/^TS error (\d+): (.+)$/);
    if (match) {
      throw new TSApiError(parseInt(match[1]), match[2]);
    }
    throw err;
  }

  if (!rawResponse.trim()) return [];
  return parseQueryResponse(rawResponse);
}

// Recursively summarize file trees for the channel selector.
fileRoutes.get('/summary', async (req: Request, res: Response, next) => {
  try {
    const rawCids = String(req.query.cids || '');
    const cids = [...new Set(rawCids.split(',').filter(Boolean).map(Number))];
    if (cids.length < 1 || cids.length > 256 || cids.some((cid) => !Number.isInteger(cid) || cid <= 0)) {
      throw new AppError(400, 'Provide between 1 and 256 valid channel IDs');
    }

    const summaries: Array<ChannelFileSummary | { cid: number; unavailable: true }> = [];
    for (const cid of cids) {
      try {
        summaries.push(await getChannelFileSummary(req, cid));
      } catch {
        summaries.push({ cid, unavailable: true });
      }
    }
    res.json(summaries);
  } catch (err) { next(err); }
});

// List files in a channel directory
// Uses shared SSH connection because ft* commands are not supported via WebQuery HTTP
fileRoutes.get('/:cid', async (req: Request, res: Response, next) => {
  try {
    const result = await sshExecute(req, 'ftgetfilelist', {
      cid: String(req.params.cid),
      cpw: String(req.query.cpw || ''),
      path: String(req.query.path || '/'),
    });
    res.json(result);
  } catch (err: any) {
    // TS3 error 1281 = database_empty_result → empty directory
    if (err instanceof TSApiError && err.code === 1281) {
      return res.json([]);
    }
    if (err.message?.includes('SSH not connected') || err.message?.includes('SSH credentials')) {
      return next(new AppError(400, 'SSH credentials not configured for this server. File browsing requires SSH access because WebQuery HTTP does not support ft* commands.'));
    }
    next(err);
  }
});

// Create directory
fileRoutes.post('/:cid/mkdir', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await sshExecute(req, 'ftcreatedir', {
      cid: String(req.params.cid),
      cpw: '',
      dirname: req.body.dirname,
    });
    fileSummaryCache.delete(fileSummaryKey(req, Number(req.params.cid)));
    res.json(result);
  } catch (err) { next(err); }
});

// Delete file
fileRoutes.delete('/:cid/file', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await sshExecute(req, 'ftdeletefile', {
      cid: String(req.params.cid),
      cpw: '',
      name: req.body.name,
    });
    fileSummaryCache.delete(fileSummaryKey(req, Number(req.params.cid)));
    res.json(result);
  } catch (err) { next(err); }
});
