import type { PrismaClient } from '../../../generated/prisma/index.js';
import { loadPlaylistVoteSettings } from '../playlist-vote-settings.js';
import { playlistVotesForRemote } from '../playlist-vote/lifecycle.js';
import {
  botKeyFor,
  channelIdFor,
  eventsQueued,
  PLAYLIST_VOTE_WINDOW_MS,
  startCurrentIfIdle,
  type PlaylistVoteRuntime,
} from '../playlist-vote/runtime.js';
import {
  playlistSongsToQueueItems,
  restashForApproval,
  settleExpiredPlaylistVote,
  type RequestPlaylist,
} from '../playlist-vote/approval-settle.js';
import { deliverPlaylistVoteAnnouncements } from '../playlist-vote/announce.js';
import { musicHistoryErrorCode, recordMusicRequests } from '../music-request-history.js';
import { listHumanMediaListeners, resolveMediaIdentity } from '../media-listeners.js';
import { authorizeMediaCommandGroup, loadMediaCommandPermissions } from '../media-command-permissions.js';
import type { VoiceBot } from '../voice-bot.js';
import type { CommandContext } from './context.js';
import { tryClaimChatInfoReply } from './dedupe.js';
import { mediaScope } from './media-access.js';

function privateReply(context: CommandContext, bot: VoiceBot, clid: number, message: string, scope = 'playlist-vote-private'): void {
  if (bot.floodHoldActive) return;
  const configId = bot.currentConfig.serverConfigId;
  const sid = context.virtualServerIdForBot(bot.currentConfig.id);
  if (!tryClaimChatInfoReply(configId, sid, 0, clid, scope)) return;
  try {
    bot.sendTextMessage(clid, message);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.warn(`[MusicCmd] Private playlistvote reply failed: ${msg}`);
  }
}

function loadPlaylist(prisma: PrismaClient, serverConfigId: number, playlistId: number): Promise<RequestPlaylist | null> {
  return prisma.playlist.findFirst({
    where: {
      id: playlistId,
      remoteAccess: { in: ['browse', 'request'] },
      OR: [{ serverConfigId }, { serverConfigId: null }],
    },
    select: {
      id: true,
      name: true,
      remoteAccess: true,
      songs: {
        where: { song: { serverConfigId } },
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
  }) as Promise<RequestPlaylist | null>;
}

async function saveHistory(
  prisma: PrismaClient,
  bot: VoiceBot,
  items: Parameters<typeof recordMusicRequests>[2],
): Promise<void> {
  const serverConfigId = bot.currentConfig.serverConfigId;
  if (!serverConfigId || items.length === 0) return;
  try {
    await recordMusicRequests(prisma, { serverConfigId, musicBotId: bot.currentConfig.id }, items);
  } catch (error) {
    console.error('[MusicCmd] Failed to save playlist vote history (%s)', musicHistoryErrorCode(error));
  }
}

function runtimeOf(context: CommandContext): PlaylistVoteRuntime | null {
  if (!context.listenerRemote) return null;
  return playlistVotesForRemote(context.listenerRemote) ?? null;
}

/** Start the B3 whole-playlist request lifecycle for chat `!playlist <name>`. */
export async function handleChatPlaylistRequest(
  context: CommandContext,
  bot: VoiceBot,
  clid: number,
  expectedUid: string | undefined,
  playlistId: number,
): Promise<boolean> {
  let configId: number;
  let sid: number;
  let settings: Awaited<ReturnType<typeof loadPlaylistVoteSettings>>;
  try {
    ({ configId, sid } = await mediaScope(context, bot));
    settings = await loadPlaylistVoteSettings(context.prisma, configId, sid);
  } catch {
    privateReply(context, bot, clid, 'Playlist voting is unavailable right now.', 'playlist-request-private');
    return true;
  }
  if (!settings.enabled) return false;

  const runtime = runtimeOf(context);
  if (!runtime) {
    privateReply(context, bot, clid, 'Playlist voting is unavailable right now.', 'playlist-request-private');
    return true;
  }

  const botKey = botKeyFor(bot.currentConfig.id);
  const channelIdNum = bot.getCurrentChannelId();
  const nowMs = context.playlistVoteNow();
  let bypass = false;
  try {
    const permissions = await loadMediaCommandPermissions(context.prisma, configId, sid);
    if (permissions.playlistBypass.serverGroupIds.length > 0 && context.eventBridge) {
      const identity = await resolveMediaIdentity(
        (cmd) => context.eventBridge!.executeCommand(configId, sid, cmd),
        clid,
        expectedUid,
      );
      bypass = !!identity
        && authorizeMediaCommandGroup(permissions, 'queue', identity)
        && authorizeMediaCommandGroup(permissions, 'playlistBypass', identity);
    }
  } catch {
    // A permission lookup failure can never grant the no-vote action.
  }

  if (bypass && channelIdNum != null && runtime.machine.getOpen(botKey, channelIdFor(channelIdNum))) {
    privateReply(context, bot, clid, 'A playlist vote is already running in this channel.', 'playlist-request-private');
    return true;
  }

  const playlist = await loadPlaylist(context.prisma, configId, playlistId);
  if (!playlist || playlist.remoteAccess !== 'request') {
    privateReply(context, bot, clid, 'This playlist does not allow whole-playlist requests.', 'playlist-request-private');
    return true;
  }
  const items = playlistSongsToQueueItems(playlist.songs.map(({ song }) => song));
  if (items.length === 0) {
    privateReply(context, bot, clid, 'This playlist has no eligible tracks.', 'playlist-request-private');
    return true;
  }
  if (items.length > settings.maxRequestSize) {
    privateReply(context, bot, clid, `Playlist requests are limited to ${settings.maxRequestSize} tracks.`, 'playlist-request-private');
    return true;
  }

  if (bypass) {
    const queued = runtime.queueDirect(bot.currentConfig.id, items);
    if (queued.result !== 'queued') {
      privateReply(context, bot, clid, 'The queue is full.', 'playlist-request-private');
      return true;
    }
    await startCurrentIfIdle(bot, queued.startItem);
    await saveHistory(context.prisma, bot, items);
    privateReply(context, bot, clid, `Queued playlist "${playlist.name.slice(0, 60)}" (${items.length} tracks) without a vote.`, 'playlist-request-private');
    return true;
  }

  if (channelIdNum == null || !context.eventBridge) {
    privateReply(context, bot, clid, 'Could not verify listeners right now.', 'playlist-request-private');
    return true;
  }
  const channelId = channelIdFor(channelIdNum);
  const excluded = context.musicBotClidsOnServer(configId, sid);
  excluded.add(bot.ts3ClientId);
  const listeners = await listHumanMediaListeners(
    (cmd) => context.eventBridge!.executeCommand(configId, sid, cmd),
    channelIdNum,
    excluded,
  );
  if (bot.floodHoldActive || bot.getCurrentChannelId() !== channelIdNum) return true;
  const requester = listeners?.find((peer) => peer.clid === clid && (!expectedUid || peer.uid === expectedUid));
  if (!listeners || !requester) {
    privateReply(context, bot, clid, 'Playlist requests need a verified listener in the bot channel.', 'playlist-request-private');
    return true;
  }

  const open = runtime.machine.getOpen(botKey, channelId);
  if (open && nowMs >= open.deadlineMs) {
    await settleExpiredPlaylistVote({
      runtime,
      botId: bot.currentConfig.id,
      channelId: channelIdNum,
      serverConfigId: configId,
      listenerUids: listeners.map((peer) => peer.uid),
      maxTracks: settings.maxRequestSize,
      nowMs,
      announceBot: bot,
      loadPlaylist: (serverConfigId, id) => loadPlaylist(context.prisma, serverConfigId, id),
      onQueued: async (start) => {
        await startCurrentIfIdle(bot, start.item);
        await saveHistory(context.prisma, bot, start.items);
      },
    });
  }
  const current = runtime.machine.getOpen(botKey, channelId);
  if (current && !(current.requesterUid === requester.uid && current.playlist.id === playlist.id)) {
    privateReply(context, bot, clid, 'A playlist vote is already running in this channel.', 'playlist-request-private');
    return true;
  }

  runtime.stash(botKey, channelId, {
    botId: bot.currentConfig.id,
    playlistId: playlist.id,
    maxTracks: settings.maxRequestSize,
    items,
    refreshedAtMs: nowMs,
  });
  const opened = runtime.machine.openVote({
    botKey,
    channelId,
    requesterUid: requester.uid,
    playlist: { id: playlist.id, name: playlist.name, trackCount: items.length },
    settings: {
      thresholdPercent: settings.thresholdPercent,
      windowMs: PLAYLIST_VOTE_WINDOW_MS,
      maxTracks: settings.maxRequestSize,
    },
    listenerUids: listeners.map((peer) => peer.uid),
    nowMs,
  });
  if (!opened.ok) {
    if (!runtime.machine.getOpen(botKey, channelId)) runtime.clearStash(botKey, channelId);
    const message = opened.code === 'request_too_large'
      ? `Playlist requests are limited to ${settings.maxRequestSize} tracks.`
      : opened.code === 'vote_running'
        ? 'A playlist vote is already running in this channel.'
        : opened.code === 'rate_limited'
          ? 'Too many playlist requests. Try again shortly.'
          : 'Could not open a playlist vote right now.';
    privateReply(context, bot, clid, message, 'playlist-request-private');
    return true;
  }

  deliverPlaylistVoteAnnouncements(bot, channelIdNum, opened.events);
  if (eventsQueued(opened.events)) {
    const start = runtime.takeStart(opened.vote.id);
    if (start) {
      await startCurrentIfIdle(bot, start.item);
      await saveHistory(context.prisma, bot, start.items);
    }
    privateReply(context, bot, clid, 'Playlist vote passed — queued.', 'playlist-request-private');
  } else {
    privateReply(context, bot, clid, opened.created
      ? 'Playlist vote started. You are counted as yes.'
      : 'Your playlist vote is already running.', 'playlist-request-private');
  }
  return true;
}

/** Chat `!playlistvote yes|no` against the shared B3 PlaylistVoteRuntime. */
export async function handlePlaylistVote(
  context: CommandContext,
  bot: VoiceBot,
  clid: number,
  args: string,
  expectedUid?: string,
): Promise<void> {
  const choiceRaw = args.trim().toLowerCase();
  if (choiceRaw !== 'yes' && choiceRaw !== 'no') {
    privateReply(context, bot, clid, 'Usage: !playlistvote yes | !playlistvote no');
    return;
  }
  const choice = choiceRaw as 'yes' | 'no';

  const runtime = runtimeOf(context);
  if (!runtime) {
    privateReply(context, bot, clid, 'Playlist voting is unavailable right now.');
    return;
  }

  let scope: { configId: number; sid: number };
  try { scope = await mediaScope(context, bot); } catch {
    privateReply(context, bot, clid, 'Could not verify listeners right now.');
    return;
  }
  const { configId, sid } = scope;
  const channelIdNum = bot.getCurrentChannelId();
  if (channelIdNum == null) {
    privateReply(context, bot, clid, 'Join the bot channel to vote.');
    return;
  }

  const excluded = context.musicBotClidsOnServer(configId, sid);
  excluded.add(bot.ts3ClientId);
  const listeners = context.eventBridge
    ? await listHumanMediaListeners(
      (cmd) => context.eventBridge!.executeCommand(configId, sid, cmd),
      channelIdNum,
      excluded,
    )
    : null;
  if (bot.floodHoldActive || bot.getCurrentChannelId() !== channelIdNum) return;

  if (!listeners) {
    privateReply(context, bot, clid, 'Could not verify listeners right now.');
    return;
  }
  const voter = listeners.find((peer) => peer.clid === clid && (!expectedUid || peer.uid === expectedUid));
  if (!voter) {
    privateReply(context, bot, clid, 'Playlist voting needs a verified listener in the bot channel.');
    return;
  }

  const botKey = botKeyFor(bot.currentConfig.id);
  const channelId = channelIdFor(channelIdNum);
  const nowMs = context.playlistVoteNow();
  const settings = await loadPlaylistVoteSettings(context.prisma, configId, sid);
  const listenerUids = listeners.map((peer) => peer.uid);

  const limited = runtime.checkBallotRate(botKey, voter.uid, nowMs);
  if (limited) {
    privateReply(context, bot, clid, 'Too many vote actions. Try again shortly.');
    return;
  }

  const open = runtime.machine.getOpen(botKey, channelId);
  if (!open) {
    privateReply(context, bot, clid, 'No open playlist vote in this channel.');
    return;
  }

  if (nowMs >= open.deadlineMs) {
    const settled = await settleExpiredPlaylistVote({
      runtime,
      botId: bot.currentConfig.id,
      channelId: channelIdNum,
      serverConfigId: configId,
      listenerUids,
      maxTracks: settings.maxRequestSize,
      nowMs,
      announceBot: bot,
      loadPlaylist: (serverConfigId, playlistId) => loadPlaylist(context.prisma, serverConfigId, playlistId),
      onQueued: async (start) => {
        await startCurrentIfIdle(bot, start.item);
        await saveHistory(context.prisma, bot, start.items);
      },
    });
    if (settled.queued) {
      privateReply(context, bot, clid, 'Playlist vote passed — queued.');
      return;
    }
    privateReply(context, bot, clid, 'That playlist vote has ended.');
    return;
  }

  await restashForApproval({
    runtime,
    botId: bot.currentConfig.id,
    channelId: channelIdNum,
    playlistId: open.playlist.id,
    maxTracks: settings.maxRequestSize,
    nowMs,
    expectVoteId: open.id,
    serverConfigId: configId,
    loadPlaylist: (serverConfigId, playlistId) => loadPlaylist(context.prisma, serverConfigId, playlistId),
  });

  const result = runtime.machine.castBallot({
    voteId: open.id,
    botKey,
    channelId,
    voterUid: voter.uid,
    choice,
    listenerUids,
    nowMs,
  });
  runtime.recordBallot(botKey, voter.uid, nowMs);

  if (!result.ok) {
    if (result.code === 'listeners_unavailable') {
      privateReply(context, bot, clid, 'Could not verify listeners right now.');
      return;
    }
    if (result.code === 'invalid_request') {
      privateReply(context, bot, clid, 'You cannot withdraw the requester ballot.');
      return;
    }
    privateReply(context, bot, clid, 'No open playlist vote in this channel.');
    return;
  }

  deliverPlaylistVoteAnnouncements(bot, channelIdNum, result.events);
  if (eventsQueued(result.events)) {
    const start = runtime.takeStart(open.id);
    if (start) {
      await startCurrentIfIdle(bot, start.item);
      await saveHistory(context.prisma, bot, start.items);
    }
    privateReply(context, bot, clid, 'Playlist vote passed — queued.');
    return;
  }

  if (result.vote.status === 'cancelled') {
    privateReply(context, bot, clid, 'Playlist vote cancelled.');
    return;
  }
  if (result.vote.status === 'failed') {
    privateReply(context, bot, clid, 'Playlist vote failed.');
    return;
  }
  privateReply(
    context,
    bot,
    clid,
    `Playlist vote: ${result.vote.yes}/${result.vote.needed} yes (${result.vote.listeners} listeners).`,
  );
}
