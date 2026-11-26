import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { actorFromRequest, recordLocalSuccess } from '../audit/index.js';
import {
  loadPlaylistVoteSettings,
  parsePlaylistVoteSettings,
  savePlaylistVoteSettings,
} from '../voice/playlist-vote-settings.js';

export const playlistVoteSettingsRoutes: Router = Router({ mergeParams: true });

playlistVoteSettingsRoutes.use(requireRole('admin'));

function voteScope(req: Request): { configId: number; sid: number } {
  const configId = Number(req.params.configId);
  const sid = Number(req.params.sid);
  if (!Number.isSafeInteger(configId) || configId <= 0 || !Number.isSafeInteger(sid) || sid <= 0) {
    throw new AppError(400, 'A valid server connection and virtual server are required');
  }
  return { configId, sid };
}

playlistVoteSettingsRoutes.get('/:sid', async (req: Request, res: Response, next) => {
  try {
    const { configId, sid } = voteScope(req);
    res.json(await loadPlaylistVoteSettings(req.app.locals.prisma, configId, sid));
  } catch (err) { next(err); }
});

playlistVoteSettingsRoutes.put('/:sid', async (req: Request, res: Response, next) => {
  try {
    const { configId, sid } = voteScope(req);
    const settings = parsePlaylistVoteSettings(req.body);
    if (!settings) {
      throw new AppError(
        400,
        'Supply enabled (boolean), thresholdPercent (1–100) and maxRequestSize (1–500)',
      );
    }
    const { result } = await recordLocalSuccess(
      req.app.locals.prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'settings.playlist_vote_update',
        connectionId: configId,
        virtualServerId: sid,
        target: { type: 'settings', id: 'playlist-vote' },
      },
      (tx) => savePlaylistVoteSettings(tx, configId, sid, settings),
    );
    res.json(result);
  } catch (err) { next(err); }
});
