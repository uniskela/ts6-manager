/**
 * Media audit (1.9.0): who started/stopped/switched media on which bot.
 * Rows carry only the action, bot id, connection and outcome — never source
 * URLs, titles, or request bodies (IPTV URLs can embed credentials).
 */

import type { Request } from 'express';
import type { AdminAuditAction } from '@ts6/common';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';
import type { VoiceBot } from '../voice/voice-bot.js';

type MediaAction = Extract<AdminAuditAction, `media.${string}`>;

/**
 * Run a media dispatch under an audit row. A start that names sessions to
 * replace is recorded as `media.session.switch`.
 */
export function runMediaAudited<T>(
  req: Request,
  bot: VoiceBot,
  action: MediaAction,
  dispatch: () => Promise<T>,
  replaceSessionIds: string[] = [],
): Promise<T> {
  const isStart = action === 'media.music.start' || action === 'media.video.start';
  return runRemoteAudited(
    req.app.locals.prisma,
    {
      actor: actorFromRequest(req.user),
      action: isStart && replaceSessionIds.length > 0 ? 'media.session.switch' : action,
      connectionId: bot.currentConfig.serverConfigId,
      target: { type: 'music_bot', id: bot.id },
    },
    dispatch,
  );
}
