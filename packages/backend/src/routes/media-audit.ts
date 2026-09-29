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

/** Stop rows for the sessions a switch stopped, each on the bot that lost it. */
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

/**
 * Run a media dispatch under an audit row. A start that names sessions to
 * replace is recorded as `media.session.switch`, plus a stop row for each
 * confirmed session the dispatch actually stopped, under the same operation.
 * Stops are collected as they happen, so one that precedes a failed start is
 * still recorded.
 */
export async function runMediaAudited<T>(
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

  const confirmed = new Set(replaceSessionIds);
  const replaced: MediaSessionInfo[] = [];
  const onReplaced = (session: MediaSessionInfo) => {
    if (confirmed.has(session.id)) replaced.push(session);
  };
  if (isSwitch) manager?.on('mediaSessionReplaced', onReplaced);

  try {
    return await runRemoteAudited(
      req.app.locals.prisma,
      {
        actor,
        action: isSwitch ? 'media.session.switch' : action,
        connectionId: bot.currentConfig.serverConfigId,
        target: { type: 'music_bot', id: bot.id },
      },
      dispatch,
      isSwitch ? { relatedAfter: () => replacedSessionRows(manager, actor, replaced) } : undefined,
    );
  } finally {
    manager?.off('mediaSessionReplaced', onReplaced);
  }
}
