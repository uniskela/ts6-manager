import type { VoiceBot } from '../voice-bot.js';
import { MediaSessionConflictError } from '../media-session.js';
import { QueueFullError, type QueueItem } from '../playlist/queue.js';
import { isYouTubeHostUrl } from '../audio/youtube.js';

export type NamedRecord = { id: number; name: string };

export type PlaylistSongRow = {
  position: number;
  song: {
    id: number;
    title: string;
    artist?: string | null;
    duration?: number | null;
    filePath: string;
    source: string;
    sourceUrl?: string | null;
  };
};

export type PlaylistCatalog = {
  playlist: {
    findMany(args: any): Promise<any[]>;
    findFirst(args: any): Promise<any>;
    create(args: any): Promise<any>;
  };
  radioStation: {
    findMany(args: any): Promise<any[]>;
  };
  song: {
    findFirst(args: any): Promise<any>;
    create(args: any): Promise<any>;
  };
  playlistSong: {
    findUnique(args: any): Promise<any>;
    create(args: any): Promise<any>;
    deleteMany(args: any): Promise<any>;
    aggregate(args: any): Promise<any>;
  };
  $transaction?<T>(fn: (tx: PlaylistCatalog) => Promise<T>): Promise<T>;
};

export function catalogScopeWhere(serverConfigId: number) {
  return {
    AND: [
      { OR: [{ serverConfigId }, { serverConfigId: null }] },
      { OR: [{ musicBot: null }, { musicBot: { serverConfigId } }] },
    ],
  };
}

export function matchNamed<T extends NamedRecord>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byId = /^[1-9]\d*$/.test(q) ? items.filter((item) => item.id === Number(q)) : [];
  if (byId.length) return byId;
  const exact = items.filter((item) => item.name.toLowerCase() === q);
  if (exact.length) return exact;
  return items.filter((item) => item.name.toLowerCase().includes(q));
}

export function formatNamedMatchError(kind: 'playlist' | 'station', matches: NamedRecord[], listHint: string): string {
  if (!matches.length) return `${kind === 'playlist' ? 'Playlist' : 'Station'} not found. Use ${listHint}.`;
  return `Ambiguous ${kind}; use an ID: ${matches.slice(0, 5).map((item) => `[${item.id}] ${item.name.slice(0, 60)}`).join(', ')}`;
}

export function formatPlaylistList(playlists: NamedRecord[]): string {
  return playlists.length
    ? `Playlists (first 10):\n${playlists.slice(0, 10).map((p) => `[${p.id}] ${p.name.slice(0, 60)}`).join('\n')}`
    : 'No playlists configured for this bot/server.';
}

export async function loadPlaylistSummaries(db: PlaylistCatalog, serverConfigId: number): Promise<NamedRecord[]> {
  return db.playlist.findMany({
    where: catalogScopeWhere(serverConfigId),
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

export function songsToQueueItems(songs: PlaylistSongRow[]): QueueItem[] {
  return songs.map(({ song }) => ({
    id: String(song.id),
    title: song.title,
    artist: song.artist ?? undefined,
    duration: song.duration ?? undefined,
    filePath: song.filePath,
    source: song.source as QueueItem['source'],
    sourceUrl: song.sourceUrl ?? undefined,
  }));
}

/** Remove only this request's items; restore cursor only if that prior track is still queued. */
function releaseOwnedPlaylistItems(
  bot: VoiceBot,
  owned: QueueItem[],
  previousCurrent: QueueItem | null,
): void {
  for (const item of [...owned].reverse()) {
    const index = bot.queue.getAll().indexOf(item);
    if (index >= 0) bot.queue.removeAt(index);
  }
  if (!previousCurrent) return;
  const index = bot.queue.getAll().indexOf(previousCurrent);
  if (index >= 0) bot.queue.playAt(index);
}

export async function enqueueSavedPlaylist(
  db: PlaylistCatalog,
  bot: VoiceBot,
  query: string,
  opts: {
    musicSwitch?: { replaceSessionIds: string[] };
    listHint?: string;
    isCurrent?: () => boolean;
  } = {},
): Promise<{ ok: true; name: string; count: number; items: QueueItem[] } | { ok: false; message: string }> {
  const serverConfigId = bot.currentConfig.serverConfigId;
  if (!serverConfigId) return { ok: false, message: 'No server configured.' };
  const stopGeneration = bot.stopGeneration;
  const stillOurs = () => bot.stopGeneration === stopGeneration && opts.isCurrent?.() !== false;
  const summaries = await loadPlaylistSummaries(db, serverConfigId);
  const matches = matchNamed(summaries, query);
  if (matches.length !== 1) {
    return { ok: false, message: formatNamedMatchError('playlist', matches, opts.listHint ?? '!playlist to list') };
  }
  const playlist = await db.playlist.findFirst({
    where: { ...catalogScopeWhere(serverConfigId), id: matches[0].id },
    include: { songs: { include: { song: true }, orderBy: { position: 'asc' } } },
  });
  if (!playlist?.songs.length) return { ok: false, message: 'Playlist is empty.' };
  if (!stillOurs()) {
    return { ok: false, message: 'Playback was stopped before the playlist was loaded.' };
  }
  const items = songsToQueueItems(playlist.songs);
  const replaceIds = opts.musicSwitch?.replaceSessionIds;
  // Reject media-session conflicts before mutating the shared queue.
  if (bot.status === 'connected' && !bot.nowPlaying) {
    try {
      bot.assertMusicCanStart(replaceIds);
    } catch (err) {
      if (err instanceof MediaSessionConflictError) return { ok: false, message: err.message };
      throw err;
    }
  }
  if (!stillOurs()) {
    return { ok: false, message: 'Playback was stopped before the playlist was loaded.' };
  }

  const previousCurrent = bot.queue.current;
  try {
    bot.queue.addMany(items);
  } catch (err) {
    if (err instanceof QueueFullError) return { ok: false, message: err.message };
    throw err;
  }

  // Append behind active music, or leave queued when not in a startable connected state.
  if (bot.status !== 'connected' || bot.nowPlaying) {
    return { ok: true, name: playlist.name, count: items.length, items };
  }

  if (!stillOurs()) {
    releaseOwnedPlaylistItems(bot, items, previousCurrent);
    return { ok: false, message: 'Playback was stopped before the playlist was loaded.' };
  }

  try {
    bot.assertMusicCanStart(replaceIds);
  } catch (err) {
    releaseOwnedPlaylistItems(bot, items, previousCurrent);
    if (err instanceof MediaSessionConflictError) return { ok: false, message: err.message };
    throw err;
  }

  const first = bot.queue.playAt(bot.queue.index < 0 ? 0 : bot.queue.index + 1);
  let started = false;
  try {
    if (first) await bot.play(first, opts.musicSwitch);
    started = stillOurs() && first != null && bot.nowPlaying === first;
  } catch (err) {
    // Clear audio only while this request still owns nowPlaying (not a newer Play B).
    if (first && bot.nowPlaying === first) bot.stopAudio({ keepPendingRequests: true });
    if (stillOurs()) releaseOwnedPlaylistItems(bot, items, previousCurrent);
    if (err instanceof MediaSessionConflictError || err instanceof Error) {
      return { ok: false, message: err.message };
    }
    throw err;
  }
  if (!started) {
    // Stop may clear the queue then a late play() re-sets nowPlaying — clear that orphan.
    if (first && bot.nowPlaying === first) bot.stopAudio({ keepPendingRequests: true });
    if (stillOurs()) releaseOwnedPlaylistItems(bot, items, previousCurrent);
    return { ok: false, message: 'Playback was stopped before the playlist was loaded.' };
  }
  return { ok: true, name: playlist.name, count: items.length, items };
}

export async function loadRadioStations(
  db: PlaylistCatalog,
  serverConfigId: number,
): Promise<Array<NamedRecord & { url: string; genre?: string | null }>> {
  return db.radioStation.findMany({
    where: { serverConfigId },
    orderBy: { name: 'asc' },
  });
}

export function radioQueueItem(station: NamedRecord & { url: string; genre?: string | null }): QueueItem {
  return {
    id: `radio_${station.id}`,
    title: station.name,
    artist: station.genre ?? 'Radio',
    filePath: '',
    source: 'radio',
    streamUrl: station.url,
  };
}

export function canEditPlaylist(playlist: { serverConfigId: number | null }, serverConfigId: number): boolean {
  return playlist.serverConfigId === serverConfigId;
}

export async function createServerPlaylist(
  db: PlaylistCatalog,
  input: { name: string; serverConfigId: number; musicBotId: number },
): Promise<{ ok: true; id: number; name: string } | { ok: false; message: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: 'Usage: /playlist create <name>' };
  const existing = matchNamed(await loadPlaylistSummaries(db, input.serverConfigId), name)
    .filter((item) => item.name.toLowerCase() === name.toLowerCase());
  if (existing.length) return { ok: false, message: `Playlist "${name.slice(0, 60)}" already exists ([${existing[0].id}]).` };
  const created = await db.playlist.create({
    data: {
      name,
      mode: 'stream',
      musicBotId: input.musicBotId,
      serverConfigId: input.serverConfigId,
    },
  });
  return { ok: true, id: created.id, name: created.name };
}

export async function addUrlToPlaylist(
  db: PlaylistCatalog,
  input: { query: string; url: string; serverConfigId: number },
): Promise<{ ok: true; playlist: string; title: string } | { ok: false; message: string }> {
  const summaries = await loadPlaylistSummaries(db, input.serverConfigId);
  const matches = matchNamed(summaries, input.query);
  if (matches.length !== 1) return { ok: false, message: formatNamedMatchError('playlist', matches, '/playlist list') };
  const playlist = await db.playlist.findFirst({
    where: { ...catalogScopeWhere(input.serverConfigId), id: matches[0].id },
    include: { songs: { include: { song: true }, orderBy: { position: 'asc' } } },
  });
  if (!playlist) return { ok: false, message: 'Playlist not found. Use /playlist list.' };
  if (!canEditPlaylist(playlist, input.serverConfigId)) {
    return { ok: false, message: 'Shared or foreign playlists cannot be edited from this server.' };
  }
  const work = async (tx: PlaylistCatalog) => {
    let song = await tx.song.findFirst({
      where: { sourceUrl: input.url, serverConfigId: input.serverConfigId },
    });
    if (!song) {
      song = await tx.song.create({
        data: {
          // Temporary title; enrich title/duration/artwork later via the existing media pipeline.
          title: input.url,
          artist: null,
          duration: null,
          filePath: '',
          source: isYouTubeHostUrl(input.url) ? 'youtube' : 'url',
          sourceUrl: input.url,
          fileSize: null,
          serverConfigId: input.serverConfigId,
        },
      });
    }
    const existing = await tx.playlistSong.findUnique({
      where: { playlistId_songId: { playlistId: playlist.id, songId: song.id } },
    });
    if (existing) return { added: false as const, title: song.title };
    const maxPos = await tx.playlistSong.aggregate({
      where: { playlistId: playlist.id },
      _max: { position: true },
    });
    await tx.playlistSong.create({
      data: { playlistId: playlist.id, songId: song.id, position: (maxPos._max.position ?? -1) + 1 },
    });
    return { added: true as const, title: song.title };
  };
  const result = db.$transaction ? await db.$transaction(work) : await work(db);
  if (!result.added) return { ok: false, message: 'That URL is already in the playlist.' };
  return { ok: true, playlist: playlist.name, title: result.title };
}

export async function removeTrackFromPlaylist(
  db: PlaylistCatalog,
  input: { query: string; track: string; serverConfigId: number },
): Promise<{ ok: true; playlist: string; title: string } | { ok: false; message: string }> {
  const summaries = await loadPlaylistSummaries(db, input.serverConfigId);
  const matches = matchNamed(summaries, input.query);
  if (matches.length !== 1) return { ok: false, message: formatNamedMatchError('playlist', matches, '/playlist list') };
  const playlist = await db.playlist.findFirst({
    where: { ...catalogScopeWhere(input.serverConfigId), id: matches[0].id },
    include: { songs: { include: { song: true }, orderBy: { position: 'asc' } } },
  });
  if (!playlist) return { ok: false, message: 'Playlist not found. Use /playlist list.' };
  if (!canEditPlaylist(playlist, input.serverConfigId)) {
    return { ok: false, message: 'Shared or foreign playlists cannot be edited from this server.' };
  }
  const songs = playlist.songs as PlaylistSongRow[];
  const track = input.track.trim();
  const byPosition = /^[1-9]\d*$/.test(track) ? songs[Number(track) - 1] : undefined;
  const q = track.toLowerCase();
  const exact = songs.filter((row: PlaylistSongRow) => row.song.title.toLowerCase() === q);
  const partial = songs.filter((row: PlaylistSongRow) => row.song.title.toLowerCase().includes(q));
  const chosen = byPosition ?? (exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined);
  if (!chosen) {
    return {
      ok: false,
      message: (exact.length > 1 || partial.length > 1)
        ? 'Ambiguous track; use a position number from /playlist list.'
        : 'Track not found in that playlist.',
    };
  }
  await db.playlistSong.deleteMany({ where: { playlistId: playlist.id, songId: chosen.song.id } });
  return { ok: true, playlist: playlist.name, title: chosen.song.title };
}
