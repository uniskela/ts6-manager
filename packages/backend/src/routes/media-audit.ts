/**
 * Media audit (1.9.0): who started/stopped/switched media on which bot.
 * Rows carry only the action, bot id, connection and outcome — never source
 * URLs, titles, or request bodies (IPTV URLs can embed credentials).
 */

import type { Request } from 'express';
import type { AdminAuditAction, MediaSessionInfo } from '@ts6/common';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';
import type { AuditActor } from '../audit/writer.js';
import type { VoiceBot } from '../voice/voice-bot.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';

type MediaAction = Extract<AdminAuditAction, `media.${string}`>;

/** Stop rows for sessions dispatch actually replaced (not a pre-dispatch snapshot). */
function replacedSessionRows(
  manager: VoiceBotManager | undefined,
  actor: AuditActor,
  sessions: MediaSessionInfo[],
) {
  return sessions.map((s) => ({
    actor,
    action: (s.kind === 'video' ? 'media.video.stop' : 'media.music.stop') as MediaAction,
    connectionId: manager?.getBot(s.botId)?.currentConfig.serverConfigId ?? null,
    target: { type: 'music_bot' as const, id: s.botId },
  }));
}

/** Narrow dispatch results that report replaced media sessions. */
function asReplacedSessions(result: unknown): MediaSessionInfo[] {
  if (!Array.isArray(result)) return [];
  return result.filter(
    (s): s is MediaSessionInfo =>
      s != null
      && typeof s === 'object'
      && typeof (s as MediaSessionInfo).id === 'string'
      && ((s as MediaSessionInfo).kind === 'video' || (s as MediaSessionInfo).kind === 'music')
      && typeof (s as MediaSessionInfo).botId === 'number',
  );
}

/**
 * Run a media dispatch under an audit row. A start that names sessions to
 * replace is recorded as `media.session.switch`, plus a stop row per session
 * the dispatch actually replaced (from its return value), under the same
 * operation.
 */
export function runMediaAudited<T>(
  req: Request,
  bot: VoiceBot,
  action: MediaAction,
  dispatch: () => Promise<T>,
  replaceSessionIds: string[] = [],
): Promise<T> {
  const isStart = action === 'media.music.start' || action === 'media.video.start';
  const isSwitch = isStart && replaceSessionIds.length > 0;
  const actor = actorFromRequest(req.user);
  const manager = req.app.locals.voiceBotManager as VoiceBotManager | undefined;
  return runRemoteAudited(
    req.app.locals.prisma,
    {
      actor,
      action: isSwitch ? 'media.session.switch' : action,
      connectionId: bot.currentConfig.serverConfigId,
      target: { type: 'music_bot', id: bot.id },
    },
    dispatch,
    isSwitch
      ? {
          resolveRelated: (result) =>
            replacedSessionRows(manager, actor, asReplacedSessions(result)),
        }
      : undefined,
  );
}
