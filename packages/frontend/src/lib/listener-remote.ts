/** Listener remote client for the T04 contract. Session stays in memory only. */

export const REMOTE_POLL_MS = 5_000;

const SESSION = /^[A-Za-z0-9_-]{43}$/;
const SEARCH_RESULT_ID = /^[A-Za-z0-9_-]{22}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const HTTP_URL = /^https?:\/\//i;

const DURATION_REFUSAL_MESSAGES: Record<string, string> = {
  too_long: 'This track is longer than 15 minutes.',
  live_not_allowed: 'Live streams are not allowed.',
  duration_unknown: 'Track duration could not be verified.',
};

export class RemoteHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Whole seconds from a 429 `Retry-After`, when the server sent one. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'RemoteHttpError';
  }
}

export type RemoteSession = { session: string; expiresAt: string; botId: number };
export type RemoteTrack = { id: string; title: string; artist: string | null; duration: number | null };
export type RemotePermissions = {
  searchLibrary: boolean;
  addToQueue: boolean;
  requestUrl: boolean;
  /**
   * A3+ `/state` flag for shared playlist browse. Optional so older backends that omit
   * the key still parse; see `canBrowseRemotePlaylists`.
   */
  browsePlaylists?: boolean;
  /** C2+ `/state` flag; missing means false. See `canSearchRemoteMusic`. */
  searchMusic: boolean;
  /** B3: may propose or queue a whole playlist. Missing means false. */
  requestPlaylist?: boolean;
  /** B3: may cast a ballot (any current listener). Missing means false. */
  vote?: boolean;
};
export type RemoteState = {
  bot: { id: number; name: string; status: string };
  nowPlaying: RemoteTrack | null;
  upNext: RemoteTrack[];
  upNextCount: number;
  permissions: RemotePermissions;
  /** B3 settings; null when the backend does not send them. */
  playlistRequests: RemotePlaylistRequestSettings | null;
  /** The open vote on this bot and channel, or the last one for 30 s after it closes. */
  vote: RemoteVote | null;
};
export type RemoteSong = { id: number; title: string; artist: string | null; duration: number | null };
export type RemoteLibrary = { songs: RemoteSong[]; page: number; pageSize: number };
/** K1 / `@ts6/common` ListenerRemotePlaylist allow-list. */
export type RemotePlaylist = {
  id: number;
  name: string;
  trackCount: number;
  duration: number | null;
  wholeRequest: boolean;
};
/** `GET /playlists` page. */
export type RemotePlaylistPage = { playlists: RemotePlaylist[]; page: number; pageSize: number };
/** `GET /playlists/:id/songs` page. */
export type RemotePlaylistSongsPage = {
  playlist: RemotePlaylist;
  songs: RemoteSong[];
  page: number;
  pageSize: number;
};
/** Opaque search hit; no source URLs. */
export type RemoteSearchResult = { id: string; title: string; artist: string | null; duration: number };
export type RemoteSearchResponse = { results: RemoteSearchResult[]; expiresAt: string };

const unavailable = () => new RemoteHttpError(503, 'unavailable', 'Listener remote is unavailable.');

let current: RemoteSession | null = null;
const exchanges = new Map<string, Promise<RemoteSession>>();
let exchangeGeneration = 0;
let rememberedGeneration = 0;
let mutationTail: Promise<void> = Promise.resolve();

export type RemotePhase =
  | { kind: 'opening' }
  | { kind: 'need-link' }
  | { kind: 'ended'; message: string }
  | { kind: 'ready'; nonce: number };

/** Stay on the current controller when the session string did not change. */
export function settleRemoteExchange(
  current: RemotePhase,
  before: string | null,
  after: string | null,
  error: string | null,
): RemotePhase {
  if (after && (error || (current.kind === 'ready' && before === after))) {
    return current.kind === 'ready' ? current : { kind: 'ready', nonce: 0 };
  }
  if (!after) return { kind: 'ended', message: error ?? 'Remote access is invalid or expired' };
  return { kind: 'ready', nonce: current.kind === 'ready' ? current.nonce + 1 : 1 };
}

export function remoteSession(): RemoteSession | null {
  if (current && Date.parse(current.expiresAt) <= Date.now()) current = null;
  return current;
}

export function clearRemoteSession(): void {
  current = null;
}

export function resetRemoteClientForTests(): void {
  current = null;
  exchanges.clear();
  exchangeGeneration = 0;
  rememberedGeneration = 0;
  mutationTail = Promise.resolve();
}

export function remoteErrorMessage(error: unknown): string {
  return error instanceof RemoteHttpError ? error.message : 'Listener remote is unavailable.';
}

/** Prefer clear duration refusals; otherwise keep server text (e.g. queue_full). */
export function remoteSearchQueueErrorMessage(error: unknown): string {
  if (error instanceof RemoteHttpError) {
    const mapped = DURATION_REFUSAL_MESSAGES[error.code];
    if (mapped) return mapped;
    if (error.code === 'not_found') return 'These search results have run out. Search again.';
    if (error.code === 'rate_limited') return 'Too many requests right now. Wait a minute, then try again.';
  }
  return remoteErrorMessage(error);
}

export function remoteSearchErrorMessage(error: unknown): string {
  if (error instanceof RemoteHttpError && error.code === 'rate_limited') {
    return 'Too many searches right now. Wait a minute, then try again.';
  }
  return remoteErrorMessage(error);
}

export type SearchQueueFailure = { message: string; drop: 'none' | 'row' | 'all' };

/**
 * Message for a failed `POST /search/queue`, and which results are now spent.
 * The backend claims a result before any other check and never restores it, so
 * after any server answer that row is gone. A 404 means the whole set expired
 * or a newer search replaced it. A 400 was refused before the claim.
 */
export function searchQueueFailure(error: unknown): SearchQueueFailure {
  const message = remoteSearchQueueErrorMessage(error);
  if (!(error instanceof RemoteHttpError)) return { message: `${message} Search again to try this song.`, drop: 'row' };
  if (error.code === 'not_found') return { message, drop: 'all' };
  if (error.status === 400) return { message, drop: 'none' };
  const final = error.code in DURATION_REFUSAL_MESSAGES || error.status === 403;
  return { message: final ? message : `${message} Search again to try this song.`, drop: 'row' };
}

/**
 * Search needs `searchMusic` and the add permission: `POST /search` checks
 * `add`, so hide the view when the listener cannot queue a result anyway.
 */
export function canSearchRemoteMusic(permissions: RemotePermissions): boolean {
  return permissions.searchMusic === true && permissions.addToQueue === true;
}

/** Client-side checks for POST /search (2–100 chars, no http(s) URLs). */
export function remoteSearchQueryError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2) return 'Enter at least 2 characters.';
  if (trimmed.length > 100) return 'Search queries can be at most 100 characters.';
  if (CONTROL_CHARS.test(trimmed) || trimmed.startsWith('-')) return 'That search is not allowed.';
  if (HTTP_URL.test(trimmed)) return 'Paste a song name, not a link.';
  return null;
}

/** At most one state poll per five seconds, and only while the page is visible. */
export function shouldPollRemote(visible: boolean, lastAt: number, now: number): boolean {
  return visible && now - lastAt >= REMOTE_POLL_MS;
}

/**
 * Show the Playlists view when A3 advertises `browsePlaylists`, or — when that
 * key is absent — fall back to `searchLibrary`. Both map to the same read-group
 * permission as `GET /library`, so pre-A3 `/state` that omits the flag still
 * reveals the UI once the A3 routes exist; an explicit `false` hides it.
 */
export function canBrowseRemotePlaylists(permissions: RemotePermissions): boolean {
  if (typeof permissions.browsePlaylists === 'boolean') return permissions.browsePlaylists;
  return permissions.searchLibrary === true;
}

export function formatTrackLength(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function statusWord(status: string): string {
  if (status === 'playing') return 'Playing';
  if (status === 'paused') return 'Paused';
  return 'Connected';
}

/** T04 state has duration, not an elapsed position. */
export function playbackSummary(track: RemoteTrack | null, status: string): { label: string; playing: boolean; length: string | null; state: string } {
  const length = formatTrackLength(track?.duration);
  const playing = status === 'playing';
  const state = statusWord(status);
  if (!track) return { label: 'Nothing is playing', playing: false, length: null, state };
  const label = length ? `${state} · ${length}` : state;
  return { label, playing, length, state };
}

export function remoteMediaUrlError(value: string): string | null {
  const url = value.trim();
  if (!url) return 'Paste a media URL.';
  if (url.length > 2048) return 'That URL is too long.';
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'Paste an http or https URL.'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Paste an http or https URL.';
  if (parsed.username || parsed.password) return 'This media URL is not allowed.';
  return null;
}

function remember(session: RemoteSession): RemoteSession {
  current = session;
  return session;
}

async function readBody(res: Response, auth: boolean): Promise<unknown> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!res.ok) {
    if (auth && res.status === 401) clearRemoteSession();
    const record = body && typeof body === 'object' ? body as { error?: unknown; code?: unknown } : {};
    const code = typeof record.code === 'string' ? record.code : 'unavailable';
    const message = typeof record.error === 'string' && record.error.length > 0 && record.error.length <= 200
      ? record.error
      : 'Listener remote is unavailable.';
    const retry = Number(res.headers.get('Retry-After'));
    const retryAfter = res.status === 429 && Number.isSafeInteger(retry) && retry > 0 ? retry : null;
    throw new RemoteHttpError(res.status, code, message, retryAfter);
  }
  return body;
}

async function remoteFetch(path: string, init: RequestInit, auth: boolean): Promise<unknown> {
  const session = auth ? remoteSession() : null;
  if (auth && !session) throw new RemoteHttpError(401, 'invalid_access', 'Remote access is invalid or expired');
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body != null) headers.set('Content-Type', 'application/json');
  if (session) headers.set('Authorization', `Bearer ${session.session}`);
  let res: Response;
  try {
    res = await fetch(`/api/listener-remote${path}`, {
      ...init,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw unavailable();
  }
  return readBody(res, auth);
}

function parseSession(body: unknown): RemoteSession {
  if (!body || typeof body !== 'object') throw unavailable();
  const row = body as Record<string, unknown>;
  if (typeof row.session !== 'string' || !SESSION.test(row.session)) throw unavailable();
  if (typeof row.expiresAt !== 'string' || Number.isNaN(Date.parse(row.expiresAt))) throw unavailable();
  if (typeof row.botId !== 'number' || !Number.isSafeInteger(row.botId) || row.botId <= 0) throw unavailable();
  return { session: row.session, expiresAt: row.expiresAt, botId: row.botId };
}

function parseTrack(value: unknown): RemoteTrack {
  if (!value || typeof value !== 'object') throw unavailable();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.title !== 'string') throw unavailable();
  const artist = row.artist ?? null;
  const duration = row.duration ?? null;
  if (artist != null && typeof artist !== 'string') throw unavailable();
  if (duration != null && typeof duration !== 'number') throw unavailable();
  return { id: row.id, title: row.title, artist, duration };
}

export function parseRemoteState(body: unknown): RemoteState {
  if (!body || typeof body !== 'object') throw unavailable();
  const row = body as Record<string, unknown>;
  const bot = row.bot;
  const permissions = row.permissions;
  if (!bot || typeof bot !== 'object' || !permissions || typeof permissions !== 'object') throw unavailable();
  const botRow = bot as Record<string, unknown>;
  const permRow = permissions as Record<string, unknown>;
  if (typeof botRow.id !== 'number' || typeof botRow.name !== 'string' || typeof botRow.status !== 'string') throw unavailable();
  if (!Array.isArray(row.upNext)) throw unavailable();
  const upNext = row.upNext.map(parseTrack);
  const upNextCount = typeof row.upNextCount === 'number' ? row.upNextCount : upNext.length;
  const parsedPermissions: RemotePermissions = {
    searchLibrary: permRow.searchLibrary === true,
    addToQueue: permRow.addToQueue === true,
    requestUrl: permRow.requestUrl === true,
    searchMusic: permRow.searchMusic === true,
  };
  // Optional B3 flags: set only when present, like browsePlaylists. Missing means no.
  if (typeof permRow.requestPlaylist === 'boolean') parsedPermissions.requestPlaylist = permRow.requestPlaylist;
  if (typeof permRow.vote === 'boolean') parsedPermissions.vote = permRow.vote;
  // Optional A3+ flag: omit when absent so older /state payloads stay valid.
  if (typeof permRow.browsePlaylists === 'boolean') {
    parsedPermissions.browsePlaylists = permRow.browsePlaylists;
  }
  return {
    bot: { id: botRow.id, name: botRow.name, status: botRow.status },
    nowPlaying: row.nowPlaying == null ? null : parseTrack(row.nowPlaying),
    upNext,
    upNextCount,
    permissions: parsedPermissions,
    playlistRequests: parsePlaylistRequestSettings(row.playlistRequests),
    // A vote this client cannot read is hidden rather than breaking the whole remote.
    vote: row.vote == null ? null : tryParseRemoteVote(row.vote),
  };
}

export function parseRemotePlaylist(value: unknown): RemotePlaylist {
  if (!value || typeof value !== 'object') throw unavailable();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0) throw unavailable();
  if (typeof row.name !== 'string') throw unavailable();
  if (typeof row.trackCount !== 'number' || !Number.isFinite(row.trackCount) || row.trackCount < 0) throw unavailable();
  const duration = row.duration ?? null;
  if (duration != null && typeof duration !== 'number') throw unavailable();
  if (typeof row.wholeRequest !== 'boolean') throw unavailable();
  return {
    id: row.id,
    name: row.name,
    trackCount: row.trackCount,
    duration,
    wholeRequest: row.wholeRequest,
  };
}

export function parseRemotePlaylistPage(body: unknown): RemotePlaylistPage {
  if (!body || typeof body !== 'object') throw unavailable();
  const row = body as Record<string, unknown>;
  if (!Array.isArray(row.playlists) || typeof row.page !== 'number') throw unavailable();
  return {
    playlists: row.playlists.map(parseRemotePlaylist),
    page: row.page,
    pageSize: typeof row.pageSize === 'number' ? row.pageSize : 25,
  };
}

export function parseRemotePlaylistSongsPage(body: unknown): RemotePlaylistSongsPage {
  if (!body || typeof body !== 'object') throw unavailable();
  const row = body as Record<string, unknown>;
  if (!Array.isArray(row.songs) || typeof row.page !== 'number') throw unavailable();
  return {
    playlist: parseRemotePlaylist(row.playlist),
    songs: row.songs.map(parseSong),
    page: row.page,
    pageSize: typeof row.pageSize === 'number' ? row.pageSize : 25,
  };
}

function parseSearchResult(value: unknown): RemoteSearchResult {
  if (!value || typeof value !== 'object') throw unavailable();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !SEARCH_RESULT_ID.test(row.id)) throw unavailable();
  if (typeof row.title !== 'string') throw unavailable();
  const artist = row.artist ?? null;
  if (artist != null && typeof artist !== 'string') throw unavailable();
  if (typeof row.duration !== 'number' || !Number.isFinite(row.duration)) throw unavailable();
  // Keep only the public fields — never pass through source URLs or provider ids.
  return { id: row.id, title: row.title, artist, duration: row.duration };
}

export function parseRemoteSearchResponse(body: unknown): RemoteSearchResponse {
  if (!body || typeof body !== 'object') throw unavailable();
  const row = body as Record<string, unknown>;
  if (!Array.isArray(row.results)) throw unavailable();
  if (typeof row.expiresAt !== 'string' || Number.isNaN(Date.parse(row.expiresAt))) throw unavailable();
  return {
    results: row.results.map(parseSearchResult),
    expiresAt: row.expiresAt,
  };
}

function parseLibrary(body: unknown): RemoteLibrary {
  if (!body || typeof body !== 'object') throw unavailable();
  const row = body as Record<string, unknown>;
  if (!Array.isArray(row.songs) || typeof row.page !== 'number') throw unavailable();
  return {
    songs: row.songs.map(parseSong),
    page: row.page,
    pageSize: typeof row.pageSize === 'number' ? row.pageSize : 25,
  };
}

function parseSong(value: unknown): RemoteSong {
  if (!value || typeof value !== 'object') throw unavailable();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0) throw unavailable();
  if (typeof row.title !== 'string') throw unavailable();
  const artist = row.artist ?? null;
  const duration = row.duration ?? null;
  if (artist != null && typeof artist !== 'string') throw unavailable();
  if (duration != null && typeof duration !== 'number') throw unavailable();
  return { id: row.id, title: row.title, artist, duration };
}

export function exchangeRemoteToken(token: string): Promise<RemoteSession> {
  if (!SESSION.test(token)) return Promise.reject(new RemoteHttpError(400, 'invalid_request', 'Invalid listener request.'));
  const existing = exchanges.get(token);
  if (existing) return existing;
  const generation = ++exchangeGeneration;
  const pending = remoteFetch('/exchange', { method: 'POST', body: JSON.stringify({ token }) }, false)
    .then(parseSession)
    .then((session) => {
      // A newer success wins. A failed later attempt must not drop an older success.
      if (generation < rememberedGeneration) return session;
      rememberedGeneration = generation;
      return remember(session);
    });
  pending.catch((error: unknown) => {
    if (!(error instanceof RemoteHttpError) || error.status >= 500) exchanges.delete(token);
  });
  exchanges.set(token, pending);
  return pending;
}

export function loadRemoteState(): Promise<RemoteState> {
  return remoteFetch('/state', { method: 'GET' }, true).then(parseRemoteState);
}

export function loadRemoteLibrary(search: string, page: number): Promise<RemoteLibrary> {
  const q = search.slice(0, 200);
  const p = Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
  const path = `/library?${new URLSearchParams({ search: q, page: String(p) })}`;
  return remoteFetch(path, { method: 'GET' }, true).then(parseLibrary);
}

export function loadRemotePlaylists(search: string, page: number): Promise<RemotePlaylistPage> {
  const q = search.slice(0, 200);
  const p = Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
  const path = `/playlists?${new URLSearchParams({ search: q, page: String(p) })}`;
  return remoteFetch(path, { method: 'GET' }, true).then(parseRemotePlaylistPage);
}

export function loadRemotePlaylistSongs(playlistId: number, page: number): Promise<RemotePlaylistSongsPage> {
  if (!Number.isSafeInteger(playlistId) || playlistId <= 0) {
    return Promise.reject(new RemoteHttpError(400, 'invalid_request', 'Invalid listener request.'));
  }
  const p = Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
  const path = `/playlists/${playlistId}/songs?${new URLSearchParams({ page: String(p) })}`;
  return remoteFetch(path, { method: 'GET' }, true).then(parseRemotePlaylistSongsPage);
}

export function enqueueRemoteMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(task, task);
  mutationTail = run.then(() => undefined, () => undefined);
  return run;
}

export function queueRemoteSong(songId: number): Promise<void> {
  if (!Number.isSafeInteger(songId) || songId <= 0) {
    return Promise.reject(new RemoteHttpError(400, 'invalid_request', 'Invalid listener request.'));
  }
  return remoteFetch('/queue', { method: 'POST', body: JSON.stringify({ songId }) }, true).then(() => undefined);
}

export function requestRemoteUrl(url: string): Promise<void> {
  const problem = remoteMediaUrlError(url);
  if (problem) return Promise.reject(new RemoteHttpError(400, 'invalid_request', problem));
  return remoteFetch('/requests', { method: 'POST', body: JSON.stringify({ url: url.trim() }) }, true).then(() => undefined);
}

export function searchRemoteMusic(query: string): Promise<RemoteSearchResponse> {
  const problem = remoteSearchQueryError(query);
  if (problem) return Promise.reject(new RemoteHttpError(400, 'invalid_request', problem));
  return remoteFetch('/search', { method: 'POST', body: JSON.stringify({ query: query.trim() }) }, true)
    .then(parseRemoteSearchResponse);
}

export function queueRemoteSearchResult(resultId: string): Promise<void> {
  if (!SEARCH_RESULT_ID.test(resultId)) {
    return Promise.reject(new RemoteHttpError(400, 'invalid_request', 'Invalid listener request.'));
  }
  return remoteFetch('/search/queue', { method: 'POST', body: JSON.stringify({ resultId }) }, true).then(() => undefined);
}

// --- B3/B5: whole-playlist requests and votes ---

const VOTE_ID = /^[A-Za-z0-9_-]{22}$/;
const VOTE_STATUSES = new Set(['open', 'passed', 'failed', 'cancelled']);
const VOTE_REASONS = new Set([
  'approved', 'deadline', 'requester_cancelled', 'requester_left', 'bot_unavailable',
  'revoked', 'playlist_unavailable', 'queue_full', 'listeners_unavailable',
]);

export type RemoteBallot = 'yes' | 'no';
export type RemoteVoteStatus = 'open' | 'passed' | 'failed' | 'cancelled';
export type RemoteVoteEndReason =
  | 'approved' | 'deadline' | 'requester_cancelled' | 'requester_left' | 'bot_unavailable'
  | 'revoked' | 'playlist_unavailable' | 'queue_full' | 'listeners_unavailable';
/** K1 `ListenerRemoteVote`: counts only, never who voted. */
export type RemoteVote = {
  id: string;
  status: RemoteVoteStatus;
  reason: RemoteVoteEndReason | null;
  playlist: { id: number | null; name: string; trackCount: number };
  yes: number;
  no: number;
  needed: number;
  listeners: number;
  thresholdPercent: number;
  deadline: string;
  ownBallot: RemoteBallot | null;
  isRequester: boolean;
};
export type RemotePlaylistRequestSettings = {
  voting: boolean;
  thresholdPercent: number;
  windowSeconds: number;
  maxTracks: number;
};
export type RemotePlaylistRequestResult =
  | { outcome: 'queued'; trackCount: number }
  | { outcome: 'vote'; created: boolean; vote: RemoteVote };

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}

export function parseRemoteVote(value: unknown): RemoteVote {
  if (!value || typeof value !== 'object') throw unavailable();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !VOTE_ID.test(row.id)) throw unavailable();
  if (typeof row.status !== 'string' || !VOTE_STATUSES.has(row.status)) throw unavailable();
  const reason = row.reason ?? null;
  if (reason !== null && (typeof reason !== 'string' || !VOTE_REASONS.has(reason))) throw unavailable();
  const playlist = row.playlist;
  if (!playlist || typeof playlist !== 'object') throw unavailable();
  const list = playlist as Record<string, unknown>;
  const playlistId = list.id ?? null;
  if (playlistId !== null && (typeof playlistId !== 'number' || !Number.isSafeInteger(playlistId) || playlistId <= 0)) {
    throw unavailable();
  }
  if (typeof list.name !== 'string') throw unavailable();
  if (typeof row.thresholdPercent !== 'number' || !Number.isFinite(row.thresholdPercent)) throw unavailable();
  if (typeof row.deadline !== 'string' || Number.isNaN(Date.parse(row.deadline))) throw unavailable();
  const own = row.ownBallot ?? null;
  if (own !== null && own !== 'yes' && own !== 'no') throw unavailable();
  if (typeof row.isRequester !== 'boolean') throw unavailable();
  // Allow-list: anything else the server adds (or leaks) is dropped here.
  return {
    id: row.id,
    status: row.status as RemoteVoteStatus,
    reason: reason as RemoteVoteEndReason | null,
    playlist: { id: playlistId, name: list.name, trackCount: count(list.trackCount) },
    yes: count(row.yes),
    no: count(row.no),
    needed: count(row.needed),
    listeners: count(row.listeners),
    thresholdPercent: row.thresholdPercent,
    deadline: row.deadline,
    ownBallot: own,
    isRequester: row.isRequester,
  };
}

function tryParseRemoteVote(value: unknown): RemoteVote | null {
  try { return parseRemoteVote(value); } catch { return null; }
}

function parsePlaylistRequestSettings(value: unknown): RemotePlaylistRequestSettings | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (typeof row.voting !== 'boolean' || !positive(row.thresholdPercent) || !positive(row.windowSeconds) || !positive(row.maxTracks)) {
    return null;
  }
  return {
    voting: row.voting,
    thresholdPercent: row.thresholdPercent as number,
    windowSeconds: row.windowSeconds as number,
    maxTracks: row.maxTracks as number,
  };
}

function parsePlaylistRequestResult(body: unknown): RemotePlaylistRequestResult {
  if (!body || typeof body !== 'object') throw unavailable();
  const row = body as Record<string, unknown>;
  if (row.outcome === 'queued') return { outcome: 'queued', trackCount: count(row.trackCount) };
  if (row.outcome === 'vote' && typeof row.created === 'boolean') {
    return { outcome: 'vote', created: row.created, vote: parseRemoteVote(row.vote) };
  }
  throw unavailable();
}

function parseBallotResult(body: unknown): RemoteVote {
  if (!body || typeof body !== 'object') throw unavailable();
  return parseRemoteVote((body as Record<string, unknown>).vote);
}

function votePath(voteId: string): string | null {
  return VOTE_ID.test(voteId) ? `/votes/${voteId}` : null;
}

const invalidRequest = () => new RemoteHttpError(400, 'invalid_request', 'Invalid listener request.');

export function requestRemotePlaylist(playlistId: number): Promise<RemotePlaylistRequestResult> {
  if (!Number.isSafeInteger(playlistId) || playlistId <= 0) return Promise.reject(invalidRequest());
  return remoteFetch('/playlist-requests', { method: 'POST', body: JSON.stringify({ playlistId }) }, true)
    .then(parsePlaylistRequestResult);
}

export function castRemoteBallot(voteId: string, choice: RemoteBallot): Promise<RemoteVote> {
  const path = votePath(voteId);
  if (!path || (choice !== 'yes' && choice !== 'no')) return Promise.reject(invalidRequest());
  return remoteFetch(`${path}/ballot`, { method: 'PUT', body: JSON.stringify({ choice }) }, true).then(parseBallotResult);
}

export function withdrawRemoteBallot(voteId: string): Promise<RemoteVote> {
  const path = votePath(voteId);
  if (!path) return Promise.reject(invalidRequest());
  return remoteFetch(`${path}/ballot`, { method: 'DELETE' }, true).then(parseBallotResult);
}

export function cancelRemoteVote(voteId: string): Promise<void> {
  const path = votePath(voteId);
  if (!path) return Promise.reject(invalidRequest());
  return remoteFetch(path, { method: 'DELETE' }, true).then(() => undefined);
}

export function canRequestRemotePlaylist(permissions: RemotePermissions): boolean {
  return permissions.requestPlaylist === true;
}

export function canVoteRemote(permissions: RemotePermissions): boolean {
  return permissions.vote === true;
}

/** "about 2 minutes" / "45 seconds", from a 429 Retry-After. */
export function retryAfterText(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  return `about ${Math.round(seconds / 60)} minutes`;
}

const PLAYLIST_REQUEST_MESSAGES: Record<string, string> = {
  vote_running: 'Another playlist vote is running in this channel. Wait for it to finish.',
  playlist_not_requestable: 'This playlist can be browsed, but not requested as a whole.',
  playlist_empty: 'This playlist has no songs that can be played here.',
  queue_full: 'The queue is full. Try again when some songs have played.',
  not_found: 'This playlist is no longer shared with the remote.',
  permission_denied: 'You are not allowed to request whole playlists.',
};

/** Message for a failed whole-playlist request. `request_too_large` keeps the server text, which names the limit. */
export function remotePlaylistRequestErrorMessage(error: unknown): string {
  if (!(error instanceof RemoteHttpError)) return remoteErrorMessage(error);
  if (error.code === 'rate_limited') {
    const wait = retryAfterText(error.retryAfterSeconds);
    return wait
      ? `Playlist requests are paused right now. Try again in ${wait}.`
      : 'Playlist requests are paused right now. Try again in a few minutes.';
  }
  return PLAYLIST_REQUEST_MESSAGES[error.code] ?? error.message;
}

/** Message for a failed ballot, withdrawal or cancel. */
export function remoteVoteErrorMessage(error: unknown): string {
  if (!(error instanceof RemoteHttpError)) return remoteErrorMessage(error);
  if (error.code === 'not_found') return 'This vote has already ended.';
  if (error.code === 'permission_denied') return 'Only the person who proposed this playlist can cancel the vote.';
  if (error.code === 'rate_limited') {
    const wait = retryAfterText(error.retryAfterSeconds);
    return wait ? `You are voting too quickly. Try again in ${wait}.` : 'You are voting too quickly. Wait a moment.';
  }
  if (error.code === 'unavailable') return 'The bot could not check who is in the channel. Try again.';
  return error.message;
}

/** Whole seconds left, clamped to the window so a wrong phone clock cannot show nonsense. */
export function voteSecondsLeft(vote: RemoteVote, nowMs: number, windowSeconds = 60): number {
  const left = Math.ceil((Date.parse(vote.deadline) - nowMs) / 1000);
  if (!Number.isFinite(left)) return 0;
  return Math.min(Math.max(left, 0), windowSeconds);
}

function tracks(n: number): string {
  return `${n} song${n === 1 ? '' : 's'}`;
}

/** One plain sentence for a closed vote. */
export function voteResultMessage(vote: RemoteVote): string {
  const name = `“${vote.playlist.name}”`;
  switch (vote.reason) {
    case 'approved': return `Vote passed. ${tracks(vote.playlist.trackCount)} from ${name} were added to the queue.`;
    case 'deadline': return `Vote failed. Not enough listeners voted yes for ${name} in time.`;
    case 'requester_cancelled': return vote.isRequester ? 'You cancelled the vote.' : `The vote for ${name} was cancelled by the person who proposed it.`;
    case 'requester_left': return `The vote for ${name} was cancelled because the person who proposed it left the channel.`;
    case 'bot_unavailable': return `The vote for ${name} was cancelled because the bot stopped or moved.`;
    case 'revoked': return `The vote for ${name} was cancelled because the proposer's remote access ended.`;
    case 'playlist_unavailable': return `The vote for ${name} was cancelled because the playlist is no longer shared.`;
    case 'queue_full': return `${name} could not be added because the queue is full.`;
    case 'listeners_unavailable': return 'The vote failed because the bot could not check who is in the channel.';
    default: return vote.status === 'passed' ? 'Vote passed.' : 'The vote has ended.';
  }
}

/** "2 yes · 1 no · needs 4 of 5 listeners" */
export function voteCountsText(vote: RemoteVote): string {
  return `${vote.yes} yes · ${vote.no} no · needs ${vote.needed} of ${vote.listeners} listener${vote.listeners === 1 ? '' : 's'}`;
}
