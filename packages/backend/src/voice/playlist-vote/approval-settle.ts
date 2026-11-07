/**
 * Approval-time restash + deadline settle shared by remote HTTP and chat ballots.
 * Callers inject playlist load / post-queue side effects (start + history).
 */
import type { QueueItem } from '../playlist/queue.js';
import {
  botKeyFor,
  channelIdFor,
  eventsQueued,
  type PlaylistVoteRuntime,
} from './runtime.js';

export type RequestPlaylistSong = {
  id: number;
  title: string;
  artist: string | null;
  duration: number | null;
  filePath: string;
  source: string;
  sourceUrl: string | null;
};

export type RequestPlaylist = {
  id: number;
  name: string;
  remoteAccess: string;
  songs: Array<{ song: RequestPlaylistSong }>;
};

export type QueuedStart = { botId: number; item: QueueItem; items: QueueItem[] };

export function playlistSongsToQueueItems(songs: RequestPlaylistSong[]): QueueItem[] {
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

export async function restashForApproval(input: {
  runtime: PlaylistVoteRuntime;
  botId: number;
  channelId: number;
  playlistId: number;
  maxTracks: number;
  nowMs: number;
  expectVoteId?: string;
  loadPlaylist: (serverConfigId: number, playlistId: number) => Promise<RequestPlaylist | null>;
  serverConfigId: number;
}): Promise<void> {
  const botKey = botKeyFor(input.botId);
  const channelId = channelIdFor(input.channelId);
  const before = input.runtime.machine.getOpen(botKey, channelId);
  if (!before || before.playlist.id !== input.playlistId) return;
  if (input.expectVoteId && before.id !== input.expectVoteId) return;

  const playlist = await input.loadPlaylist(input.serverConfigId, input.playlistId);
  const still = input.runtime.machine.getOpen(botKey, channelId);
  if (!still || still.playlist.id !== input.playlistId) return;
  if (input.expectVoteId && still.id !== input.expectVoteId) return;
  if (before.id !== still.id) return;

  if (!playlist || playlist.remoteAccess !== 'request') {
    input.runtime.stash(botKey, channelId, {
      botId: input.botId,
      playlistId: input.playlistId,
      maxTracks: input.maxTracks,
      items: [],
      refreshedAtMs: input.nowMs,
    });
    return;
  }
  const items = playlistSongsToQueueItems(playlist.songs.map((link) => link.song));
  input.runtime.stash(botKey, channelId, {
    botId: input.botId,
    playlistId: input.playlistId,
    maxTracks: input.maxTracks,
    items,
    refreshedAtMs: input.nowMs,
  });
}

/**
 * Close an open vote whose window has ended.
 * `listenerUids === null` → fail closed as listeners_unavailable; `[]` is empty channel.
 */
export async function settleExpiredPlaylistVote(input: {
  runtime: PlaylistVoteRuntime;
  botId: number;
  channelId: number;
  serverConfigId: number;
  listenerUids: readonly string[] | null;
  maxTracks: number;
  nowMs: number;
  loadPlaylist: (serverConfigId: number, playlistId: number) => Promise<RequestPlaylist | null>;
  onQueued?: (start: QueuedStart) => Promise<void>;
}): Promise<{ queued: boolean; start: QueuedStart | null }> {
  const botKey = botKeyFor(input.botId);
  const channelId = channelIdFor(input.channelId);
  const open = input.runtime.machine.getOpen(botKey, channelId);
  if (!open || input.nowMs < open.deadlineMs) return { queued: false, start: null };
  const voteId = open.id;

  if (input.listenerUids !== null) {
    await restashForApproval({
      runtime: input.runtime,
      botId: input.botId,
      channelId: input.channelId,
      playlistId: open.playlist.id,
      maxTracks: input.maxTracks,
      nowMs: input.nowMs,
      expectVoteId: voteId,
      loadPlaylist: input.loadPlaylist,
      serverConfigId: input.serverConfigId,
    });
  }

  const still = input.runtime.machine.getOpen(botKey, channelId);
  if (!still || still.id !== voteId) return { queued: false, start: null };

  const events = input.runtime.machine.tickDeadline({
    botKey,
    channelId,
    listenerUids: input.listenerUids,
    nowMs: input.nowMs,
  });
  if (eventsQueued(events)) {
    const start = input.runtime.takeStart(voteId);
    if (start && input.onQueued) await input.onQueued(start);
    return { queued: true, start };
  }
  input.runtime.clearStash(botKey, channelId);
  return { queued: false, start: null };
}
