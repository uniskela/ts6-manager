import type { Request } from 'express';
import { runRemoteAudited } from '../../audit/index.js';
import type { Binding as ListenerRemoteBinding } from '../../voice/listener-remote.js';
import type { PlayQueue, QueueItem } from '../../voice/playlist/queue.js';
import { startOrAppendMediaItem } from '../../voice/commands/queue.js';
import { MediaSessionConflictError } from '../../voice/media-session.js';
import { musicHistoryErrorCode, recordMusicRequests } from '../../voice/music-request-history.js';
import { authorized, botFor, fail, listenerActor, type ListenerBot } from './shared.js';

/** Tracks waiting to play that a listener request may add to. */
const MAX_UPCOMING_TRACKS = 500;
/** Played and waiting tracks together; reached only on a bot whose queue is never cleared. */
const MAX_QUEUE_ITEMS = 5000;

export type ListenerAppendAction = 'listener.remote.queue_add' | 'listener.remote.request';

/** Fail with 429 when a listener request would grow the bot's queue past its limits. */
export function assertQueueRoom(bot: { queue: Pick<PlayQueue, 'upcomingCount' | 'length'> }): void {
  // Count what is still to play: tracks already played stay in the queue and must not use up the limit.
  // The total is capped separately so listener requests cannot grow one queue without bound.
  if (bot.queue.upcomingCount >= MAX_UPCOMING_TRACKS || bot.queue.length >= MAX_QUEUE_ITEMS) {
    fail(429, 'rate_limited', 'The queue is full.');
  }
}

/**
 * Fail with 409 when the bot was stopped or its queue cleared after the
 * listener asked, so a request still resolving then cannot restart music.
 */
function assertNotStopped(bot: ListenerBot, requestedOn: ListenerBot | null, stopGeneration: number | undefined): void {
  if (bot !== requestedOn || bot.stopGeneration !== stopGeneration) {
    fail(409, 'cancelled', 'Playback was stopped before this request was ready.');
  }
}

/**
 * Audit, authorize, resolve and queue one listener item. Authorization runs
 * again after `resolveItem`, because resolving can take long enough for the
 * listener to leave or be revoked, or for someone to press Stop.
 */
export async function appendForListener(req: Request, binding: ListenerRemoteBinding, resolveItem: () => Promise<QueueItem>, action: ListenerAppendAction) {
  // Read before any await: a Stop or queue clear from here on drops this request.
  const requestedOn = botFor(req, binding);
  const stopGeneration = requestedOn?.stopGeneration;
  await runRemoteAudited(req.app.locals.prisma, {
    actor: listenerActor(binding), action, connectionId: binding.serverConfigId,
    virtualServerId: binding.virtualServerId, target: { type: 'music_bot', id: binding.botId },
  }, async () => {
    await authorized(req, 'add', 'request');
    const item = await resolveItem();
    const { bot } = await authorized(req, 'add', 'request');
    // A listener who left while the request was being checked does not get it queued.
    if (req.res?.destroyed || req.socket?.destroyed) fail(503, 'unavailable', 'Listener remote is unavailable.');
    assertNotStopped(bot, requestedOn, stopGeneration);
    assertQueueRoom(bot);
    // Conservative: a listener may only start music on an idle bot. Anything
    // already playing or paused is never touched, and an active video stream is
    // never replaced (no replaceSessionIds, unlike a chat !play); the item is
    // appended instead. There is no await between the final authorization above
    // and the queue mutation, so a revoked listener cannot start playback.
    let queued: boolean | null;
    if (bot.status === 'connected' && bot.videoSessionInfo()) {
      bot.queue.add(item);
      queued = true;
    } else {
      try {
        queued = await startOrAppendMediaItem(bot, item, () => botFor(req, binding) === bot, { replaceSessionIds: [] });
      } catch (err) {
        if (!(err instanceof MediaSessionConflictError)) throw err;
        // The rejected start resumed on a later tick; another request may have added, or Stop run, meanwhile.
        assertNotStopped(bot, requestedOn, stopGeneration);
        assertQueueRoom(bot);
        bot.queue.add(item);
        queued = true;
      }
    }
    if (queued === null) {
      // A Stop during the start is a cancellation, not an outage.
      assertNotStopped(bot, requestedOn, stopGeneration);
      fail(503, 'unavailable', 'Listener remote is unavailable.');
    }
    await saveRequestHistory(req, bot, item);
  });
}

/** History is best effort: a database failure must not fail an accepted request. */
async function saveRequestHistory(req: Request, bot: ListenerBot, item: QueueItem): Promise<void> {
  const serverConfigId = bot.currentConfig.serverConfigId;
  if (!serverConfigId) return;
  try {
    await recordMusicRequests(req.app.locals.prisma, { serverConfigId, musicBotId: bot.currentConfig.id }, [item]);
  } catch (error) {
    console.error('[listener-remote] Failed to save music request history (%s)', musicHistoryErrorCode(error));
  }
}
