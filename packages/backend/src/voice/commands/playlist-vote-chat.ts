import type { PrismaClient } from '../../../generated/prisma/index.js';
import { loadPlaylistVoteSettings } from '../playlist-vote-settings.js';
import { playlistVotesForRemote } from '../playlist-vote/lifecycle.js';
import {
  botKeyFor,
  channelIdFor,
  eventsQueued,
  startCurrentIfIdle,
  type PlaylistVoteRuntime,
} from '../playlist-vote/runtime.js';
import {
  restashForApproval,
  settleExpiredPlaylistVote,
  type RequestPlaylist,
} from '../playlist-vote/approval-settle.js';
import { musicHistoryErrorCode, recordMusicRequests } from '../music-request-history.js';
import { listHumanMediaListeners } from '../media-listeners.js';
import type { VoiceBot } from '../voice-bot.js';
import type { CommandContext } from './context.js';
import { tryClaimChatInfoReply } from './dedupe.js';
import { mediaScope } from './media-access.js';

function privateReply(context: CommandContext, bot: VoiceBot, clid: number, message: string): void {
  if (bot.floodHoldActive) return;
  const configId = bot.currentConfig.serverConfigId;
  const sid = context.virtualServerIdForBot(bot.currentConfig.id);
  if (!tryClaimChatInfoReply(configId, sid, 0, clid, 'playlist-vote-private')) return;
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

  const voter = listeners?.find((peer) => peer.clid === clid && (!expectedUid || peer.uid === expectedUid));
  if (!voter) {
    privateReply(context, bot, clid, 'Playlist voting needs a verified listener in the bot channel.');
    return;
  }
  if (!listeners) {
    privateReply(context, bot, clid, 'Could not verify listeners right now.');
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
