import type { Request } from 'express';
import { runRemoteAudited } from '../../audit/index.js';
import { ListenerRemoteError, type Binding as ListenerRemoteBinding } from '../../voice/listener-remote.js';
import type { PlayQueue, QueueItem } from '../../voice/playlist/queue.js';
import { startOrAppendMediaItem } from '../../voice/commands/queue.js';
import { MediaSessionConflictError } from '../../voice/media-session.js';
import { musicHistoryErrorCode, recordMusicRequests } from '../../voice/music-request-history.js';
import { authorized, bearerCredential, botFor, fail, listenerActor, service, type ListenerBot } from './shared.js';

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
    const full = new ListenerRemoteError(429, 'rate_limited', 'The queue is full.');
    full.auditCode = 'queue_full';
    throw full;
  }
}

/** The bound bot and its stop generation when a request arrived. */
export interface ArrivalSnapshot { bot: ListenerBot | null; stopGeneration: number | undefined }

/**
 * Take before any await in the route: a Stop or queue clear from then on drops
 * the request. Uses the session's binding without verifying it; the request is
 * authenticated afterwards as usual.
 */
export function arrivalSnapshot(req: Request): ArrivalSnapshot {
  const bound = service(req).sessionBinding(bearerCredential(req));
  const bot = bound ? botFor(req, bound) : null;
  return { bot, stopGeneration: bot?.stopGeneration };
}

/**
 * True when the bot was stopped or its queue cleared since the request arrived.
 * Without a bot to compare against there is no Stop to detect; the access checks still apply.
 */
function stoppedSince(bot: ListenerBot, arrival: ArrivalSnapshot): boolean {
  if (!arrival.bot) return false;
  return bot !== arrival.bot || bot.stopGeneration !== arrival.stopGeneration;
}

/** Fail with 409 when the bot was stopped or cleared after the listener asked. */
function assertNotStopped(bot: ListenerBot, arrival: ArrivalSnapshot): void {
  if (stoppedSince(bot, arrival)) fail(409, 'cancelled', 'Playback was stopped before this request was ready.');
}

/**
 * Authorize, audit, resolve and queue one listener item.
 *
 * The cheap refusals come first and are counted in the bounded refusal totals
 * rather than audited one by one: permission (403), a full queue (429) and
 * the request's own `precheck` (a missing song, a disallowed link, the link
 * limit). Only a request that is about to do real work opens an audit attempt.
 * Authorization runs again after `resolveItem`, because resolving can take long
 * enough for the listener to leave or be revoked, or for someone to press Stop.
 */
export async function appendForListener(
  req: Request, binding: ListenerRemoteBinding, resolveItem: () => Promise<QueueItem>, action: ListenerAppendAction,
  arrival: ArrivalSnapshot = arrivalSnapshot(req), precheck?: () => Promise<void>,
) {
  const first = await authorized(req, 'add', 'request');
  // A bot that was briefly unavailable on arrival but serves the listener now
  // has not been stopped; compare against it from here on.
  if (!arrival.bot && first.bot) arrival = { bot: first.bot, stopGeneration: first.bot.stopGeneration };
  assertQueueRoom(first.bot);
  await precheck?.();
  // From here a refusal is recorded on the attempt row, not in the refusal totals.
  if (req.res) req.res.locals.listenerRemoteAttemptOpened = true;
  await runRemoteAudited(req.app.locals.prisma, {
    actor: listenerActor(binding), action, connectionId: binding.serverConfigId,
    virtualServerId: binding.virtualServerId, target: { type: 'music_bot', id: binding.botId },
  }, async () => {
    const item = await resolveItem();
    const { bot } = await authorized(req, 'add', 'request');
    // A listener who left while the request was being checked does not get it queued.
    if (req.res?.destroyed || req.socket?.destroyed) fail(503, 'unavailable', 'Listener remote is unavailable.');
    // Still no reference bot: take it now, so a Stop during the start is still caught.
    if (!arrival.bot && bot) arrival = { bot, stopGeneration: bot.stopGeneration };
    assertNotStopped(bot, arrival);
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
        const current = () => botFor(req, binding) === bot && !stoppedSince(bot, arrival);
        queued = await startOrAppendMediaItem(bot, item, current, { replaceSessionIds: [] });
      } catch (err) {
        if (!(err instanceof MediaSessionConflictError)) throw err;
        // The rejected start resumed on a later tick; another request may have added, or Stop run, meanwhile.
        assertNotStopped(bot, arrival);
        assertQueueRoom(bot);
        bot.queue.add(item);
        queued = true;
      }
    }
    if (queued === null) {
      // A Stop during the start is a cancellation, not an outage.
      assertNotStopped(bot, arrival);
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
