import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import {
  AppError,
  TSApiError,
  TeamSpeakPermissionError,
  isTeamSpeakPermissionError,
} from '../middleware/error-handler.js';
import { parseQueryResponse, tsEscape } from '@ts6/common';
import type { BotEngine } from '../bot-engine/engine.js';
import {
  FILE_SUMMARY_DEADLINE_MS,
  FILE_SUMMARY_MAX_CHANNELS,
  FILE_SUMMARY_MAX_COMMANDS_PER_REQUEST,
  FILE_SUMMARY_MAX_DEPTH,
  FILE_SUMMARY_MAX_ENTRIES_PER_CHANNEL,
  FILE_SUMMARY_MAX_ENTRIES_PER_REQUEST,
  abortSignalFromRequest,
  fileSummaryScanCoordinator,
  selectChannelsForSummaryScan,
} from './file-summary-scan.js';

export const fileRoutes: Router = Router({ mergeParams: true });

const getConfigId = (req: Request) => parseInt(String(req.params.configId));
const getSid = (req: Request) => parseInt(String(req.params.sid));

async function listChannelPath(req: Request, cid: number, path: string): Promise<Record<string, string>[]> {
  try {
    return await sshExecute(req, 'ftgetfilelist', { cid: String(cid), cpw: '', path });
  } catch (err) {
    if (err instanceof TSApiError && err.code === 1281) return [];
    throw err;
  }
}

/**
 * Execute a ServerQuery command via the shared SSH connection (EventBridge).
 * Reuses the same SSH session used for bot events — no extra server slots.
 */
function demoFileCommand(command: string, params: Record<string, string>): Record<string, string>[] {
  if (command === 'ftgetfilelist') {
    const path = params.path || '/';
    if (path === '/') {
      return [
        { name: 'README.txt', size: '2048', datetime: '1700000000', type: '0' },
        { name: 'Shared', size: '0', datetime: '1700000100', type: '1' },
      ];
    }
    if (path === '/Shared') {
      return [
        { name: 'sample-notes.txt', size: '4096', datetime: '1700000200', type: '0' },
        { name: 'example-image.png', size: '32768', datetime: '1700000300', type: '0' },
      ];
    }
    return [];
  }

  if (command === 'ftcreatedir' || command === 'ftdeletefile') {
    return [{ success: '1', demo: '1' }];
  }

  return [];
}

async function sshExecute(
  req: Request,
  command: string,
  params: Record<string, string>,
): Promise<Record<string, string>[]> {
  const configId = getConfigId(req);
  const prisma = req.app.locals.prisma;
  const server = await prisma.tsServerConfig.findUnique({
    where: { id: configId },
    select: { isDemo: true },
  });

  if (server?.isDemo) {
    return demoFileCommand(command, params);
  }

  const engine: BotEngine = req.app.locals.botEngine;
  if (!engine) throw new AppError(503, 'Bot engine not available');

  const bridge = engine.getEventBridge();
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

function mapFileSshTransportError(err: Error, purpose: 'browse' | 'changes'): AppError | null {
  const msg = err.message || '';
  if (msg.includes('SSH not connected')) {
    return new AppError(
      502,
      purpose === 'browse'
        ? 'Could not browse files: SSH is not connected. Check SSH credentials and that the Query session is connected.'
        : 'Could not change files: SSH is not connected. Check SSH credentials and that the Query session is connected.',
    );
  }
  if (msg.includes('SSH credentials')) {
    return new AppError(
      400,
      purpose === 'browse'
        ? 'SSH credentials not configured for this server. File browsing requires SSH access because WebQuery HTTP does not support ft* commands.'
        : 'SSH credentials not configured for this server. File changes require SSH access because WebQuery HTTP does not support ft* commands.',
    );
  }
  return null;
}

function mapFileMutationError(err: unknown, actionHint: string): unknown {
  if (err instanceof TSApiError && isTeamSpeakPermissionError(err)) {
    return new TeamSpeakPermissionError(err.code, err.message, actionHint);
  }
  if (err instanceof TeamSpeakPermissionError) {
    return new TeamSpeakPermissionError(err.tsCode, 'insufficient client permissions', actionHint);
  }
  if (err instanceof Error) {
    return mapFileSshTransportError(err, 'changes') ?? err;
  }
  return err;
}

function getBridgeGeneration(req: Request): number {
  const engine: BotEngine | undefined = req.app.locals.botEngine;
  if (!engine) return 0;
  try {
    return engine.getEventBridge().getClientCacheGeneration(getConfigId(req), getSid(req));
  } catch {
    return 0;
  }
}

// Recursively summarize file trees for the channel selector (bounded).
fileRoutes.get('/summary', async (req: Request, res: Response, next) => {
  try {
    const rawCids = String(req.query.cids || '');
    const requested = [...new Set(rawCids.split(',').filter(Boolean).map(Number))];
    if (requested.length < 1 || requested.some((cid) => !Number.isInteger(cid) || cid <= 0)) {
      throw new AppError(400, 'Provide at least one valid channel ID');
    }
    // Accept oversized lists: bound the scan set and label the remainder Not scanned.
    // (Previously rejected >256 with 400 — the Files UI could not explain that.)
    const { scanIds, omittedIds } = selectChannelsForSummaryScan(requested, FILE_SUMMARY_MAX_CHANNELS);

    const configId = getConfigId(req);
    const sid = getSid(req);
    const connectionGeneration = getBridgeGeneration(req);
    const cacheGeneration = fileSummaryScanCoordinator.getCacheGeneration(configId, sid);
    const signal = abortSignalFromRequest(req, res);
    const now = Date.now();

    const response = await fileSummaryScanCoordinator.runRequest({
      configId,
      sid,
      cids: scanIds,
      omittedCids: omittedIds,
      connectionGeneration,
      cacheGeneration,
      deadlineAt: now + FILE_SUMMARY_DEADLINE_MS,
      maxCommands: FILE_SUMMARY_MAX_COMMANDS_PER_REQUEST,
      maxEntries: FILE_SUMMARY_MAX_ENTRIES_PER_REQUEST,
      maxDepth: FILE_SUMMARY_MAX_DEPTH,
      maxEntriesPerChannel: FILE_SUMMARY_MAX_ENTRIES_PER_CHANNEL,
      signal,
      listPath: (cid, path) => listChannelPath(req, cid, path),
      getConnectionGeneration: () => getBridgeGeneration(req),
      getCacheGeneration: () => fileSummaryScanCoordinator.getCacheGeneration(configId, sid),
    });

    res.json(response);
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
    if (err instanceof Error) {
      const mapped = mapFileSshTransportError(err, 'browse');
      if (mapped) return next(mapped);
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
    fileSummaryScanCoordinator.invalidateChannel(getConfigId(req), getSid(req), Number(req.params.cid));
    res.json(result);
  } catch (err) {
    next(mapFileMutationError(err, 'creating directories'));
  }
});

// Delete file
fileRoutes.delete('/:cid/file', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const result = await sshExecute(req, 'ftdeletefile', {
      cid: String(req.params.cid),
      cpw: '',
      name: req.body.name,
    });
    fileSummaryScanCoordinator.invalidateChannel(getConfigId(req), getSid(req), Number(req.params.cid));
    res.json(result);
  } catch (err) {
    next(mapFileMutationError(err, 'deleting files'));
  }
});
