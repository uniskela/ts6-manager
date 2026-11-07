import type { Request, Router } from 'express';
import { z } from 'zod';
import { runRemoteAudited } from '../../audit/index.js';
import { listHumanMediaListeners } from '../../voice/media-listeners.js';
import { loadPlaylistVoteSettings } from '../../voice/playlist-vote-settings.js';
import {
  PLAYLIST_VOTE_WINDOW_MS,
  botKeyFor,
  channelIdFor,
  eventsQueued,
  playlistVotesOf,
  startCurrentIfIdle,
  type PlaylistVoteRuntime,
  type VoteBot,
} from '../../voice/playlist-vote/runtime.js';
import type { PlaylistVotePublic } from '../../voice/playlist-vote/state-machine.js';
import type { QueueItem } from '../../voice/playlist/queue.js';
import { musicHistoryErrorCode, recordMusicRequests } from '../../voice/music-request-history.js';
import type { VoiceBotManager } from '../../voice/voice-bot-manager.js';
import type { EventBridge } from '../../bot-engine/event-bridge.js';
import { ListenerRemoteError } from '../../voice/listener-remote.js';
import { arrivalSnapshot } from './append.js';
import {
  authorized,
  body,
  endpoint,
  fail,
  listenerActor,
  type ListenerBot,
} from './shared.js';

const WINDOW_SECONDS = 60;

const requestBody = z.object({
  playlistId: z.number().int().positive().safe(),
}).strict();

const ballotBody = z.object({
  choice: z.enum(['yes', 'no']),
}).strict();

function voteIdParam(raw: unknown): string {
  const parsed = z.string().regex(/^[A-Za-z0-9_-]{22}$/).safeParse(raw);
  if (!parsed.success) fail(404, 'not_found', 'Vote not found.');
  return parsed.data;
}

function visibleWhere(serverConfigId: number) {
  return {
    remoteAccess: { in: ['browse', 'request'] as const },
    OR: [{ serverConfigId }, { serverConfigId: null }],
  };
}

function songsOnServer(serverConfigId: number) {
  return { song: { serverConfigId } };
}

function rateLimited(retryAfterMs: number): never {
  throw new ListenerRemoteError(
    429,
    'rate_limited',
    'Too many remote requests',
    Math.max(1, Math.ceil(retryAfterMs / 1000)),
  );
}

function runtimeOf(req: Request): PlaylistVoteRuntime {
  const manager = req.app.locals.voiceBotManager as VoiceBotManager;
  return playlistVotesOf(req.app, (botId) => manager.getBot(botId) as VoteBot | null | undefined);
}

/** Tests inject `app.locals.playlistVoteClock`; production uses wall time. */
function nowMsOf(req: Request): number {
  const clock = req.app.locals.playlistVoteClock as (() => number) | undefined;
  return typeof clock === 'function' ? clock() : Date.now();
}

function toRemoteVote(vote: PlaylistVotePublic, playlistIdVisible: boolean) {
  return {
    ...vote,
    playlist: {
      ...vote.playlist,
      id: playlistIdVisible ? vote.playlist.id : null,
    },
  };
}

async function humanListenerUids(req: Request, binding: { botId: number; serverConfigId: number; virtualServerId: number; channelId: number }): Promise<string[] | null> {
  const bridge = req.app.locals.eventBridge as EventBridge | undefined;
  const manager = req.app.locals.voiceBotManager as VoiceBotManager;
  if (!bridge) return null;
  const query = (cmd: string) => bridge.executeCommand(binding.serverConfigId, binding.virtualServerId, cmd);
  const bots = await manager.getBotsForServer(binding.serverConfigId);
  const excluded = new Set(bots.map(({ bot }) => bot.ts3ClientId));
  const listeners = await listHumanMediaListeners(query, binding.channelId, excluded);
  if (!listeners) return null;
  return listeners.map((listener) => listener.uid);
}

type SongRow = {
  id: number;
  title: string;
  artist: string | null;
  duration: number | null;
  filePath: string;
  source: string;
  sourceUrl: string | null;
};

function toQueueItems(songs: SongRow[]): QueueItem[] {
  return songs.map((song) => ({
    id: String(song.id),
    title: song.title,
    artist: song.artist ?? undefined,
    duration: song.duration ?? undefined,
    filePath: song.filePath,
    source: song.source as QueueItem['source'],
    sourceUrl: song.sourceUrl ?? undefined,
  }));
}

async function loadRequestPlaylist(req: Request, serverConfigId: number, playlistId: number) {
  return req.app.locals.prisma.playlist.findFirst({
    where: { id: playlistId, ...visibleWhere(serverConfigId) },
    select: {
      id: true,
      name: true,
      remoteAccess: true,
      songs: {
        where: songsOnServer(serverConfigId),
        select: {
          song: {
            select: {
              id: true, title: true, artist: true, duration: true,
              filePath: true, source: true, sourceUrl: true,
            },
          },
        },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      },
    },
  }) as Promise<{
    id: number;
    name: string;
    remoteAccess: string;
    songs: Array<{ song: SongRow }>;
  } | null>;
}

async function playlistVisible(req: Request, serverConfigId: number, playlistId: number | null): Promise<boolean> {
  if (playlistId == null) return false;
  const row = await req.app.locals.prisma.playlist.findFirst({
    where: { id: playlistId, ...visibleWhere(serverConfigId) },
    select: { id: true },
  });
  return Boolean(row);
}

async function saveHistory(req: Request, bot: ListenerBot, items: QueueItem[]): Promise<void> {
  const serverConfigId = bot.currentConfig.serverConfigId;
  if (!serverConfigId || items.length === 0) return;
  try {
    await recordMusicRequests(req.app.locals.prisma, { serverConfigId, musicBotId: bot.currentConfig.id }, items);
  } catch (error) {
    console.error('[listener-remote] Failed to save playlist request history (%s)', musicHistoryErrorCode(error));
  }
}

async function maybeStart(req: Request, botId: number, item: QueueItem | null): Promise<void> {
  if (!item) return;
  const manager = req.app.locals.voiceBotManager as VoiceBotManager;
  const bot = manager.getBot(botId) as VoteBot | undefined;
  if (bot) await startCurrentIfIdle(bot, item);
}

/** Re-read playlist at approval; stash tracks for the sync queue hook. */
async function restashForApproval(
  req: Request,
  runtime: PlaylistVoteRuntime,
  binding: { botId: number; serverConfigId: number; channelId: number },
  playlistId: number,
  maxTracks: number,
): Promise<void> {
  const botKey = botKeyFor(binding.botId);
  const channelId = channelIdFor(binding.channelId);
  const playlist = await loadRequestPlaylist(req, binding.serverConfigId, playlistId);
  if (!playlist || playlist.remoteAccess !== 'request') {
    runtime.stash(botKey, channelId, { botId: binding.botId, playlistId, maxTracks, items: [] });
    return;
  }
  const items = toQueueItems(playlist.songs.map((link) => link.song));
  runtime.stash(botKey, channelId, { botId: binding.botId, playlistId, maxTracks, items });
}

/**
 * Close an open vote whose window has ended. `listenerUids === null` means
 * lookup failed (fail closed as listeners_unavailable); `[]` is a real empty channel.
 */
async function settleExpiredVote(
  req: Request,
  runtime: PlaylistVoteRuntime,
  binding: { botId: number; serverConfigId: number; channelId: number },
  listenerUids: readonly string[] | null,
  maxTracks: number,
  nowMs: number,
): Promise<void> {
  const botKey = botKeyFor(binding.botId);
  const channelId = channelIdFor(binding.channelId);
  const open = runtime.machine.getOpen(botKey, channelId);
  if (!open || nowMs < open.deadlineMs) return;

  if (listenerUids !== null) {
    await restashForApproval(req, runtime, binding, open.playlist.id, maxTracks);
  }
  const events = runtime.machine.tickDeadline({
    botKey,
    channelId,
    listenerUids,
    nowMs,
  });
  if (eventsQueued(events)) {
    const start = runtime.takeStart(open.id);
    if (start) await maybeStart(req, start.botId, start.item);
  } else {
    runtime.clearStash(botKey, channelId);
  }
}

export function registerPlaylistRequestRoutes(router: Router): void {
  router.post('/playlist-requests', endpoint(async (req, res) => {
    const arrival = arrivalSnapshot(req);
    const { playlistId } = body(req, requestBody);
    const first = await authorized(req, 'playlist', 'request');
    const settings = await loadPlaylistVoteSettings(
      req.app.locals.prisma, first.binding.serverConfigId, first.binding.virtualServerId,
    );
    const playlist = await loadRequestPlaylist(req, first.binding.serverConfigId, playlistId);
    if (!playlist) fail(404, 'not_found', 'Playlist not found.');
    if (playlist.remoteAccess !== 'request') {
      fail(409, 'playlist_not_requestable', 'This playlist does not allow whole-playlist requests.');
    }
    const items = toQueueItems(playlist.songs.map((link) => link.song));
    if (items.length === 0) fail(422, 'playlist_empty', 'This playlist has no eligible tracks.');
    if (items.length > settings.maxRequestSize) {
      fail(422, 'request_too_large', `Playlist requests are limited to ${settings.maxRequestSize} tracks.`);
    }

    const listeners = await humanListenerUids(req, first.binding);
    if (!listeners) fail(503, 'unavailable', 'Listener remote is unavailable.');

    const runtime = runtimeOf(req);
    const botKey = botKeyFor(first.binding.botId);
    const channelId = channelIdFor(first.binding.channelId);
    const nowMs = nowMsOf(req);

    await runRemoteAudited(req.app.locals.prisma, {
      actor: listenerActor(first.binding),
      action: 'listener.remote.playlist_request',
      connectionId: first.binding.serverConfigId,
      virtualServerId: first.binding.virtualServerId,
      target: { type: 'music_bot', id: first.binding.botId },
    }, async () => {
      if (req.res) req.res.locals.listenerRemoteAttemptOpened = true;
      const { binding, bot } = await authorized(req, 'playlist', 'request');
      if (arrival.bot && (bot !== arrival.bot || bot.stopGeneration !== arrival.stopGeneration)) {
        fail(409, 'cancelled', 'Playback was stopped before this request was ready.');
      }
      if (req.res?.destroyed || req.socket?.destroyed) fail(503, 'unavailable', 'Listener remote is unavailable.');

      const liveListeners = await humanListenerUids(req, binding);
      if (!liveListeners) fail(503, 'unavailable', 'Listener remote is unavailable.');
      if (!liveListeners.includes(binding.uid)) fail(503, 'unavailable', 'Listener remote is unavailable.');

      // Re-read under the audit attempt (visibility / size / emptiness).
      const fresh = await loadRequestPlaylist(req, binding.serverConfigId, playlistId);
      if (!fresh) fail(404, 'not_found', 'Playlist not found.');
      if (fresh.remoteAccess !== 'request') {
        fail(409, 'playlist_not_requestable', 'This playlist does not allow whole-playlist requests.');
      }
      const freshItems = toQueueItems(fresh.songs.map((link) => link.song));
      if (freshItems.length === 0) fail(422, 'playlist_empty', 'This playlist has no eligible tracks.');
      if (freshItems.length > settings.maxRequestSize) {
        fail(422, 'request_too_large', `Playlist requests are limited to ${settings.maxRequestSize} tracks.`);
      }

      if (!settings.enabled) {
        const limited = runtime.checkDirectOpenRate(botKey, binding.uid, nowMs);
        if (limited) rateLimited(limited);
        runtime.recordDirectOpen(botKey, binding.uid, nowMs);
        const queued = runtime.queueDirect(binding.botId, freshItems);
        runtime.armDirectCooldown(botKey, binding.uid, nowMs, queued.result !== 'queued');
        if (queued.result !== 'queued') fail(409, 'queue_full', 'The queue is full.');
        await maybeStart(req, binding.botId, queued.startItem);
        await saveHistory(req, bot, freshItems);
        res.json({ ok: true, outcome: 'queued', trackCount: freshItems.length });
        return;
      }

      // Expire a stale open vote before treating the channel as busy (no /state required).
      await settleExpiredVote(req, runtime, binding, liveListeners, settings.maxRequestSize, nowMs);

      const existing = runtime.machine.getOpen(botKey, channelId);
      if (existing && !(existing.requesterUid === binding.uid && existing.playlist.id === fresh.id)) {
        // Do not overwrite or clear the open vote's pending tracks.
        fail(409, 'vote_running', 'A playlist vote is already running.');
      }

      // Stash only for this open (new or same requester+playlist refresh).
      runtime.stash(botKey, channelId, {
        botId: binding.botId,
        playlistId: fresh.id,
        maxTracks: settings.maxRequestSize,
        items: freshItems,
      });

      const opened = runtime.machine.openVote({
        botKey,
        channelId,
        requesterUid: binding.uid,
        playlist: { id: fresh.id, name: fresh.name, trackCount: freshItems.length },
        settings: {
          thresholdPercent: settings.thresholdPercent,
          windowMs: PLAYLIST_VOTE_WINDOW_MS,
          maxTracks: settings.maxRequestSize,
        },
        listenerUids: liveListeners,
        nowMs,
      });

      if (!opened.ok) {
        // Only clear when nothing else holds the channel (we just wrote this stash).
        if (!runtime.machine.getOpen(botKey, channelId)) runtime.clearStash(botKey, channelId);
        if (opened.code === 'rate_limited') rateLimited(opened.retryAfterMs ?? 60_000);
        if (opened.code === 'vote_running') fail(409, 'vote_running', 'A playlist vote is already running.');
        if (opened.code === 'playlist_empty') fail(422, 'playlist_empty', 'This playlist has no eligible tracks.');
        if (opened.code === 'request_too_large') {
          fail(422, 'request_too_large', `Playlist requests are limited to ${settings.maxRequestSize} tracks.`);
        }
        fail(503, 'unavailable', 'Listener remote is unavailable.');
      }

      if (eventsQueued(opened.events)) {
        const start = runtime.takeStart(opened.vote.id);
        if (start) await maybeStart(req, start.botId, start.item);
        await saveHistory(req, bot, freshItems);
      }

      // Sole-listener / immediate pass → outcome queued (API contract).
      if (opened.vote.status === 'passed' && opened.vote.reason === 'approved') {
        res.json({ ok: true, outcome: 'queued', trackCount: freshItems.length });
        return;
      }
      if (opened.vote.status === 'failed' && opened.vote.reason === 'queue_full') {
        fail(409, 'queue_full', 'The queue is full.');
      }
      if (opened.vote.status !== 'open') {
        // Failed/cancelled without queue — still surface the vote snapshot when useful.
        const visible = await playlistVisible(req, binding.serverConfigId, opened.vote.playlist.id);
        res.json({ ok: true, outcome: 'vote', created: opened.created, vote: toRemoteVote(opened.vote, visible) });
        return;
      }

      res.json({
        ok: true,
        outcome: 'vote',
        created: opened.created,
        vote: toRemoteVote(opened.vote, true),
      });
    });
  }));

  router.put('/votes/:voteId/ballot', endpoint(async (req, res) => {
    const voteId = voteIdParam(req.params.voteId);
    const { choice } = body(req, ballotBody);
    const { binding, bot } = await authorized(req, 'voteskip');
    const runtime = runtimeOf(req);
    const botKey = botKeyFor(binding.botId);
    const channelId = channelIdFor(binding.channelId);
    const nowMs = nowMsOf(req);

    const limited = runtime.checkBallotRate(botKey, binding.uid, nowMs);
    if (limited) rateLimited(limited);

    const settings = await loadPlaylistVoteSettings(
      req.app.locals.prisma, binding.serverConfigId, binding.virtualServerId,
    );
    const listeners = await humanListenerUids(req, binding);
    const open = runtime.machine.getOpen(botKey, channelId);
    if (open && open.id === voteId && nowMs >= open.deadlineMs) {
      // Terminalise even when lookup failed (null ≠ empty electorate).
      await settleExpiredVote(req, runtime, binding, listeners, settings.maxRequestSize, nowMs);
      fail(404, 'not_found', 'Vote not found.');
    }
    // Lookup failure is not an empty electorate — refuse rather than tally with [].
    if (!listeners) fail(503, 'unavailable', 'Listener remote is unavailable.');
    if (!open || open.id !== voteId) fail(404, 'not_found', 'Vote not found.');

    await restashForApproval(req, runtime, binding, open.playlist.id, settings.maxRequestSize);

    // Requester `no` cancels — audit like DELETE /votes/:voteId.
    const cancel = choice === 'no' && open.requesterUid === binding.uid;
    const cast = () => runtime.machine.castBallot({
      voteId,
      botKey,
      channelId,
      voterUid: binding.uid,
      choice,
      listenerUids: listeners,
      nowMs,
    });

    const result = cancel
      ? await runRemoteAudited(req.app.locals.prisma, {
        actor: listenerActor(binding),
        action: 'listener.remote.vote_cancel',
        connectionId: binding.serverConfigId,
        virtualServerId: binding.virtualServerId,
        target: { type: 'music_bot', id: binding.botId },
      }, async () => {
        if (req.res) req.res.locals.listenerRemoteAttemptOpened = true;
        await authorized(req, 'voteskip');
        return cast();
      })
      : cast();

    runtime.recordBallot(botKey, binding.uid, nowMs);
    if (!result.ok) {
      if (result.code === 'listeners_unavailable') fail(503, 'unavailable', 'Listener remote is unavailable.');
      if (result.code === 'invalid_request') fail(400, 'invalid_request', 'Invalid listener request.');
      fail(404, 'not_found', 'Vote not found.');
    }

    if (eventsQueued(result.events)) {
      const start = runtime.takeStart(voteId);
      if (start) await maybeStart(req, start.botId, start.item);
      const pendingItems = (await loadRequestPlaylist(req, binding.serverConfigId, open.playlist.id))
        ?.songs.map((link) => link.song) ?? [];
      await saveHistory(req, bot, toQueueItems(pendingItems));
    }

    const visible = await playlistVisible(req, binding.serverConfigId, result.vote.playlist.id);
    res.json({ ok: true, vote: toRemoteVote(result.vote, visible) });
  }));

  router.delete('/votes/:voteId/ballot', endpoint(async (req, res) => {
    const voteId = voteIdParam(req.params.voteId);
    const { binding } = await authorized(req, 'voteskip');
    const runtime = runtimeOf(req);
    const botKey = botKeyFor(binding.botId);
    const channelId = channelIdFor(binding.channelId);
    const nowMs = nowMsOf(req);

    const limited = runtime.checkBallotRate(botKey, binding.uid, nowMs);
    if (limited) rateLimited(limited);

    const listeners = await humanListenerUids(req, binding);
    if (!listeners) fail(503, 'unavailable', 'Listener remote is unavailable.');

    const result = runtime.machine.withdrawBallot({
      voteId,
      botKey,
      channelId,
      voterUid: binding.uid,
      listenerUids: listeners,
      nowMs,
    });
    runtime.recordBallot(botKey, binding.uid, nowMs);
    if (!result.ok) {
      if (result.code === 'invalid_request') fail(400, 'invalid_request', 'Invalid listener request.');
      if (result.code === 'listeners_unavailable') fail(503, 'unavailable', 'Listener remote is unavailable.');
      fail(404, 'not_found', 'Vote not found.');
    }
    const visible = await playlistVisible(req, binding.serverConfigId, result.vote.playlist.id);
    res.json({ ok: true, vote: toRemoteVote(result.vote, visible) });
  }));

  router.delete('/votes/:voteId', endpoint(async (req, res) => {
    const voteId = voteIdParam(req.params.voteId);
    // Cancel stays available after losing playlist permission; still requires a live listener.
    const { binding } = await authorized(req, 'voteskip');
    const runtime = runtimeOf(req);
    const botKey = botKeyFor(binding.botId);
    const channelId = channelIdFor(binding.channelId);
    const nowMs = nowMsOf(req);
    const listeners = await humanListenerUids(req, binding);
    if (!listeners) fail(503, 'unavailable', 'Listener remote is unavailable.');

    await runRemoteAudited(req.app.locals.prisma, {
      actor: listenerActor(binding),
      action: 'listener.remote.vote_cancel',
      connectionId: binding.serverConfigId,
      virtualServerId: binding.virtualServerId,
      target: { type: 'music_bot', id: binding.botId },
    }, async () => {
      if (req.res) req.res.locals.listenerRemoteAttemptOpened = true;
      await authorized(req, 'voteskip');
      const result = runtime.machine.cancelByRequester({
        voteId,
        botKey,
        channelId,
        requesterUid: binding.uid,
        listenerUids: listeners,
        nowMs,
      });
      if (!result.ok) {
        if (result.code === 'permission_denied') {
          fail(403, 'permission_denied', 'You are not allowed to use this command.');
        }
        fail(404, 'not_found', 'Vote not found.');
      }
      runtime.clearStash(botKey, channelId);
      res.json({ ok: true });
    });
  }));
}

/** `/state` vote + playlistRequest fields (called from library.ts). */
export async function playlistVoteStateFields(req: Request, binding: {
  botId: number;
  serverConfigId: number;
  virtualServerId: number;
  channelId: number;
  uid: string;
}) {
  const settings = await loadPlaylistVoteSettings(
    req.app.locals.prisma, binding.serverConfigId, binding.virtualServerId,
  );
  const runtime = runtimeOf(req);
  const botKey = botKeyFor(binding.botId);
  const channelId = channelIdFor(binding.channelId);
  const nowMs = nowMsOf(req);
  // null = lookup failed; [] = genuinely empty. Never coerce null → [].
  const listeners = await humanListenerUids(req, binding);

  const open = runtime.machine.getOpen(botKey, channelId);
  if (open) {
    if (listeners === null) {
      // Fail closed at deadline; do not invent an empty electorate or requester_left.
      await settleExpiredVote(req, runtime, binding, null, settings.maxRequestSize, nowMs);
    } else if (!listeners.includes(open.requesterUid)) {
      runtime.machine.cancelExternal({
        botKey,
        channelId,
        reason: 'requester_left',
        listenerUids: listeners,
        nowMs,
      });
      runtime.clearStash(botKey, channelId);
    } else {
      await settleExpiredVote(req, runtime, binding, listeners, settings.maxRequestSize, nowMs);
    }
  }

  const viewListeners = listeners ?? [];
  const vote = runtime.view(botKey, channelId, binding.uid, viewListeners, nowMs);
  const visible = vote ? await playlistVisible(req, binding.serverConfigId, vote.playlist.id) : false;

  return {
    playlistRequests: {
      voting: settings.enabled,
      thresholdPercent: settings.thresholdPercent,
      windowSeconds: WINDOW_SECONDS,
      maxTracks: settings.maxRequestSize,
    },
    limits: { maxRequestSeconds: 900 },
    vote: vote ? toRemoteVote(vote, visible) : null,
  };
}
