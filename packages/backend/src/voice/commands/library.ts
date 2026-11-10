import type { VoiceBot } from '../voice-bot.js';
import { AppError } from '../../middleware/error-handler.js';
import { MediaSessionConflictError, publicMediaTitle, safeUrlDisplayTitle } from '../media-session.js';
import { QueueFullError, type QueueItem } from '../playlist/queue.js';
import { isYouTubeHostUrl } from '../audio/youtube.js';
import {
  ensurePlaylistNameKeyConstraintsReady,
  findPlaylistNameOccupant,
  isPlaylistNameUniqueViolation,
  normalizePlaylistDisplayName,
  normalizePlaylistNameKey,
  PlaylistNameConflictError,
} from './playlist-name.js';

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
    ? `Playlists (first 10):\n${playlists.slice(0, 10).map((p) => `[${p.id}] ${p.name.slice(0, 60)}`).join('\n')}\nUse /playlist tracks <name> to list removable track positions.`
    : 'No playlists configured for this bot/server.';
}

/** Labels an operator may type for /playlist remove (display + stored + host placeholder). */
export function trackMatchLabels(song: { title: string; sourceUrl?: string | null }): string[] {
  const labels: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (labels.some((label) => label.toLowerCase() === trimmed.toLowerCase())) return;
    labels.push(trimmed);
  };
  push(song.title ?? '');
  push(publicMediaTitle(song.title, song.sourceUrl));
  if (song.sourceUrl) push(safeUrlDisplayTitle(song.sourceUrl));
  return labels;
}

export function formatPlaylistTracks(playlistName: string, songs: PlaylistSongRow[]): string {
  const name = playlistName.slice(0, 60);
  if (!songs.length) return `Playlist "${name}" is empty.`;
  const lines = songs.slice(0, 25).map((row, index) => {
    const title = publicMediaTitle(row.song.title, row.song.sourceUrl).slice(0, 80);
    return `[#${index + 1}] ${title}`;
  });
  const more = songs.length > 25 ? `\n…and ${songs.length - 25} more` : '';
  return `Tracks in "${name}" (remove with #N or title):\n${lines.join('\n')}${more}`;
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
    if (err instanceof MediaSessionConflictError) return { ok: false, message: err.message };
    if (err instanceof Error) {
      return { ok: false, message: 'Could not start playlist playback.' };
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

export type PlaylistMode = 'local' | 'stream';

export function normalizePlaylistMode(raw: unknown, fallback: PlaylistMode = 'local'): PlaylistMode {
  if (raw === 'stream' || raw === 'local') return raw;
  return fallback;
}

/** YouTube-imported playlists must stay stream-mode even if DB defaulted to local. */
export function effectivePlaylistMode(p: { mode: string; youtubePlaylistId?: string | null }): PlaylistMode {
  if (p.youtubePlaylistId) return 'stream';
  return normalizePlaylistMode(p.mode);
}

/** Same source→mode rules as REST playlist song adds. */
export function songMatchesMode(source: string, mode: PlaylistMode): boolean {
  if (mode === 'local') return source === 'local';
  return source === 'youtube' || source === 'url';
}

export function playlistModeMismatchMessage(mode: PlaylistMode): string {
  return mode === 'local'
    ? 'This local playlist only accepts local library songs'
    : 'This stream playlist only accepts YouTube / URL songs';
}

/** Source that Discord / Chat URL-add would store for this URL. */
export function urlAddSongSource(url: string): 'youtube' | 'url' {
  return isYouTubeHostUrl(url) ? 'youtube' : 'url';
}

export async function createServerPlaylist(
  db: PlaylistCatalog,
  input: { name: string; serverConfigId: number; musicBotId: number },
): Promise<{ ok: true; id: number; name: string } | { ok: false; message: string }> {
  const name = normalizePlaylistDisplayName(input.name);
  if (!name) return { ok: false, message: 'Usage: /playlist create <name>' };
  try {
    await ensurePlaylistNameKeyConstraintsReady(db as any);
  } catch (err) {
    if (err instanceof AppError) return { ok: false, message: err.message };
    throw err;
  }
  const nameKey = normalizePlaylistNameKey(name);
  const occupant = await findPlaylistNameOccupant(db as any, nameKey, input.serverConfigId);
  if (occupant) {
    return { ok: false, message: new PlaylistNameConflictError(name, occupant.id).message };
  }
  try {
    const created = await db.playlist.create({
      data: {
        name,
        nameKey,
        mode: 'stream',
        musicBotId: input.musicBotId,
        serverConfigId: input.serverConfigId,
      },
    });
    return { ok: true, id: created.id, name: created.name };
  } catch (err) {
    if (isPlaylistNameUniqueViolation(err)) {
      return { ok: false, message: new PlaylistNameConflictError(name).message };
    }
    throw err;
  }
}

export async function addUrlToPlaylist(
  db: PlaylistCatalog,
  input: { query: string; url: string; serverConfigId: number },
): Promise<{ ok: true; playlist: string; title: string; position: number } | { ok: false; message: string }> {
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
  const mode = effectivePlaylistMode(playlist);
  const source = urlAddSongSource(input.url);
  if (!songMatchesMode(source, mode)) {
    return { ok: false, message: playlistModeMismatchMessage(mode) };
  }
  const work = async (tx: PlaylistCatalog) => {
    let song = await tx.song.findFirst({
      where: { sourceUrl: input.url, serverConfigId: input.serverConfigId },
    });
    if (!song) {
      song = await tx.song.create({
        data: {
          // Neutral title only — never store the raw URL (credentials/query may be present).
          // Playback uses sourceUrl; metadata enrichment can replace the title later.
          title: safeUrlDisplayTitle(input.url),
          artist: null,
          duration: null,
          filePath: '',
          source,
          sourceUrl: input.url,
          fileSize: null,
          serverConfigId: input.serverConfigId,
        },
      });
    }
    const existing = await tx.playlistSong.findUnique({
      where: { playlistId_songId: { playlistId: playlist.id, songId: song.id } },
    });
    if (existing) return { added: false as const, title: song.title as string, position: 0 };
    const maxPos = await tx.playlistSong.aggregate({
      where: { playlistId: playlist.id },
      _max: { position: true },
    });
    const dbPosition = (maxPos._max.position ?? -1) + 1;
    await tx.playlistSong.create({
      data: { playlistId: playlist.id, songId: song.id, position: dbPosition },
    });
    return { added: true as const, title: song.title as string, position: dbPosition + 1 };
  };
  const result = db.$transaction ? await db.$transaction(work) : await work(db);
  if (!result.added) return { ok: false, message: 'That URL is already in the playlist.' };
  return { ok: true, playlist: playlist.name, title: result.title, position: result.position };
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
  const track = input.track.trim().replace(/^#/, '');
  const byPosition = /^[1-9]\d*$/.test(track) ? songs[Number(track) - 1] : undefined;
  const q = track.toLowerCase();
  const labelMatch = (row: PlaylistSongRow, mode: 'exact' | 'partial') =>
    trackMatchLabels(row.song).some((label) => {
      const lower = label.toLowerCase();
      return mode === 'exact' ? lower === q : lower.includes(q);
    });
  const exact = songs.filter((row) => labelMatch(row, 'exact'));
  const partial = songs.filter((row) => labelMatch(row, 'partial'));
  const chosen = byPosition ?? (exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined);
  if (!chosen) {
    return {
      ok: false,
      message: (exact.length > 1 || partial.length > 1)
        ? 'Ambiguous track; use a position number from /playlist tracks.'
        : 'Track not found in that playlist. Use /playlist tracks to list positions.',
    };
  }
  await db.playlistSong.deleteMany({ where: { playlistId: playlist.id, songId: chosen.song.id } });
  return { ok: true, playlist: playlist.name, title: chosen.song.title };
}
