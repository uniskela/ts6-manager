/** Listener remote client for the T04 contract. Session stays in memory only. */

export const REMOTE_POLL_MS = 5_000;

const SESSION = /^[A-Za-z0-9_-]{43}$/;

export class RemoteHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'RemoteHttpError';
  }
}

export type RemoteSession = { session: string; expiresAt: string; botId: number };
export type RemoteTrack = { id: string; title: string; artist: string | null; duration: number | null };
export type RemotePermissions = { searchLibrary: boolean; addToQueue: boolean; requestUrl: boolean };
export type RemoteState = {
  bot: { id: number; name: string; status: string };
  nowPlaying: RemoteTrack | null;
  upNext: RemoteTrack[];
  upNextCount: number;
  permissions: RemotePermissions;
};
export type RemoteSong = { id: number; title: string; artist: string | null; duration: number | null };
export type RemoteLibrary = { songs: RemoteSong[]; page: number; pageSize: number };

const unavailable = () => new RemoteHttpError(503, 'unavailable', 'Listener remote is unavailable.');

let current: RemoteSession | null = null;
const exchanges = new Map<string, Promise<RemoteSession>>();
let exchangeGeneration = 0;
let rememberedGeneration = 0;
let mutationTail: Promise<void> = Promise.resolve();

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

/** At most one state poll per five seconds, and only while the page is visible. */
export function shouldPollRemote(visible: boolean, lastAt: number, now: number): boolean {
  return visible && now - lastAt >= REMOTE_POLL_MS;
}

export function formatTrackLength(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** T04 state has duration, not an elapsed position. */
export function playbackSummary(track: RemoteTrack | null, status: string): { label: string; playing: boolean; length: string | null } {
  const length = formatTrackLength(track?.duration);
  const playing = status === 'playing';
  const state = playing ? 'Playing' : status === 'paused' ? 'Paused' : 'Connected';
  if (!track) return { label: 'Nothing is playing', playing: false, length: null };
  return { label: length ? `${state} · ${length}` : state, playing, length };
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
    throw new RemoteHttpError(res.status, code, message);
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
  const artist = row.artist == null ? null : row.artist;
  const duration = row.duration == null ? null : row.duration;
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
  return {
    bot: { id: botRow.id, name: botRow.name, status: botRow.status },
    nowPlaying: row.nowPlaying == null ? null : parseTrack(row.nowPlaying),
    upNext,
    upNextCount,
    permissions: {
      searchLibrary: permRow.searchLibrary === true,
      addToQueue: permRow.addToQueue === true,
      requestUrl: permRow.requestUrl === true,
    },
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
  const artist = row.artist == null ? null : row.artist;
  const duration = row.duration == null ? null : row.duration;
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
