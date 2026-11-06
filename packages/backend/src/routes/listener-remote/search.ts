import { randomBytes } from 'node:crypto';
import type { Request, Router } from 'express';
import { z } from 'zod';
import type { ListenerRemoteSearchResponse, ListenerRemoteSearchResult } from '@ts6/common';
import {
  checkListenerDuration,
  searchListenerMusic,
  type ListenerMusicSearchDeps,
  type ListenerSearchResult,
} from '../../voice/audio/listener-music.js';
import {
  ListenerRemoteError,
  type Binding as ListenerRemoteBinding,
} from '../../voice/listener-remote.js';
import { appendForListener, arrivalSnapshot } from './append.js';
import { listenerLink } from './link.js';
import {
  getOrCreateSearchRuntime,
  identityKey,
  type CachedTrack,
  type SearchRuntime,
} from './search-cache.js';
import { authenticate, authorized, bearer, body, endpoint, fail, service } from './shared.js';

export { clearAllListenerSearchResults, clearListenerSearchResults } from './search-cache.js';

const RESULT_TTL_MS = 5 * 60_000;
const QUERY_CACHE_TTL_MS = 10 * 60_000;
const QUERY_CACHE_MAX = 200;
const IDENTITY_RESULTS_MAX = 10_000;
const SEARCHES_PER_MINUTE = 5;
const MAX_RESULTS = 10;
/** Hard global bound on concurrent provider searches (all servers). */
const MAX_SERVICE_IN_FLIGHT = 2;
/** Per TeamSpeak server fairness: one stalled server cannot take both global slots. */
const MAX_SERVER_IN_FLIGHT = 1;
/** Provider search wall clock; shorter than the generic music-search default. */
const SEARCH_PROVIDER_TIMEOUT_MS = 30_000;
const SESSION_CHECK_MS = 2_000;
const RESULT_ID = /^[A-Za-z0-9_-]{22}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const HTTP_URL = /^https?:\/\//i;

function runtimeFor(req: Parameters<typeof service>[0]): SearchRuntime {
  const clock = (req.app.locals.listenerRemoteSearchNow as (() => number) | undefined) ?? Date.now;
  return getOrCreateSearchRuntime(service(req), clock);
}

function pruneQueryCache(runtime: SearchRuntime, now: number): void {
  for (const [key, entry] of runtime.queryCache) {
    if (entry.expiresAt <= now) runtime.queryCache.delete(key);
  }
  while (runtime.queryCache.size > QUERY_CACHE_MAX) {
    const oldest = runtime.queryCache.keys().next().value;
    if (oldest === undefined) break;
    runtime.queryCache.delete(oldest);
  }
}

function pruneIdentityResults(runtime: SearchRuntime, now: number): void {
  for (const [key, entry] of runtime.identityResults) {
    if (entry.expiresAt <= now) runtime.identityResults.delete(key);
  }
  while (runtime.identityResults.size > IDENTITY_RESULTS_MAX) {
    const oldest = runtime.identityResults.keys().next().value;
    if (oldest === undefined) break;
    runtime.identityResults.delete(oldest);
  }
}

function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseSearchQuery(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2 || trimmed.length > 100) fail(400, 'invalid_request', 'Invalid listener request.');
  if (CONTROL_CHARS.test(trimmed) || HTTP_URL.test(trimmed) || trimmed.startsWith('-')) {
    fail(400, 'invalid_request', 'Invalid listener request.');
  }
  return trimmed;
}

function toCachedTrack(row: ListenerSearchResult): CachedTrack | null {
  const verdict = checkListenerDuration({ durationSec: row.durationSec });
  if (!verdict.ok) return null;
  const artist = row.artist.trim() ? row.artist : null;
  return { url: row.url, title: row.title, artist, duration: verdict.durationSec };
}

function refuseDuration(reason: 'too_long' | 'live_not_allowed' | 'unknown_duration'): never {
  if (reason === 'too_long') fail(422, 'too_long', 'This track is longer than 15 minutes.');
  if (reason === 'live_not_allowed') fail(422, 'live_not_allowed', 'Live streams are not allowed.');
  fail(422, 'duration_unknown', 'Track duration could not be verified.');
}

/**
 * Atomically claim a result for queueing. Removes it from the identity map so a
 * concurrent request cannot acquire the same id. Fail-closed: a later failure
 * does not restore the id (listener must search again).
 */
function claimResult(runtime: SearchRuntime, binding: ListenerRemoteBinding, resultId: string): CachedTrack {
  const now = runtime.now();
  pruneIdentityResults(runtime, now);
  const key = identityKey(binding);
  const entry = runtime.identityResults.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (entry) runtime.identityResults.delete(key);
    fail(404, 'not_found', 'Search result not found.');
  }
  const track = entry.byId.get(resultId);
  if (!track) fail(404, 'not_found', 'Search result not found.');
  entry.byId.delete(resultId);
  if (entry.byId.size === 0) runtime.identityResults.delete(key);
  return track;
}

function issueResults(runtime: SearchRuntime, binding: ListenerRemoteBinding, tracks: CachedTrack[]): {
  results: ListenerRemoteSearchResult[];
  expiresAt: string;
} {
  pruneIdentityResults(runtime, runtime.now());
  const expiresAtMs = runtime.now() + RESULT_TTL_MS;
  const byId = new Map<string, CachedTrack>();
  const results: ListenerRemoteSearchResult[] = [];
  for (const track of tracks.slice(0, MAX_RESULTS)) {
    const id = randomBytes(16).toString('base64url');
    byId.set(id, track);
    results.push({ id, title: track.title, artist: track.artist, duration: track.duration });
  }
  runtime.identityResults.set(identityKey(binding), { byId, expiresAt: expiresAtMs });
  return { results, expiresAt: new Date(expiresAtMs).toISOString() };
}

function searchDeps(req: Parameters<typeof service>[0]): ListenerMusicSearchDeps | undefined {
  return req.app.locals.listenerMusicSearchDeps as ListenerMusicSearchDeps | undefined;
}

function hitSearchRate(runtime: SearchRuntime, key: string): void {
  const rate = runtime.searchRates.hit(key, [SEARCHES_PER_MINUTE], 0);
  if (rate.count > rate.limit) {
    const retryAfter = Math.max(1, Math.ceil(rate.remainingMs / 1000));
    throw new ListenerRemoteError(429, 'rate_limited', 'Too many remote requests', retryAfter);
  }
}

function beginProviderSearch(runtime: SearchRuntime, identity: string, serverConfigId: number): void {
  if (runtime.identityInFlight.has(identity)) {
    fail(429, 'rate_limited', 'Too many remote requests');
  }
  const serverCount = runtime.serverInFlight.get(serverConfigId) ?? 0;
  if (serverCount >= MAX_SERVER_IN_FLIGHT || runtime.serviceInFlight >= MAX_SERVICE_IN_FLIGHT) {
    fail(429, 'rate_limited', 'Too many remote requests');
  }
  runtime.identityInFlight.add(identity);
  runtime.serverInFlight.set(serverConfigId, serverCount + 1);
  runtime.serviceInFlight++;
}

function endProviderSearch(runtime: SearchRuntime, identity: string, serverConfigId: number): void {
  runtime.identityInFlight.delete(identity);
  const serverCount = runtime.serverInFlight.get(serverConfigId) ?? 0;
  if (serverCount <= 1) runtime.serverInFlight.delete(serverConfigId);
  else runtime.serverInFlight.set(serverConfigId, serverCount - 1);
  runtime.serviceInFlight = Math.max(0, runtime.serviceInFlight - 1);
}

/** Abort when the client leaves, the session dies, or the provider timeout fires. */
function openSearchSignal(req: Request, session: string): { signal: AbortSignal; dispose: () => void } {
  const remote = service(req);
  const controller = new AbortController();
  const abort = (err: ListenerRemoteError) => {
    if (!controller.signal.aborted) controller.abort(err);
  };
  const onClose = () => {
    if (!req.res?.writableEnded) {
      abort(new ListenerRemoteError(503, 'unavailable', 'Listener remote is unavailable.'));
    }
  };
  const timeoutMs = Number(req.app.locals.listenerRemoteSearchTimeoutMs) || SEARCH_PROVIDER_TIMEOUT_MS;
  const checkMs = Number(req.app.locals.listenerRemoteSearchSessionCheckMs) || SESSION_CHECK_MS;
  const timeout = setTimeout(() => {
    abort(new ListenerRemoteError(504, 'timeout', 'The search took too long.'));
  }, timeoutMs);
  const sessionCheck = setInterval(() => {
    if (!remote.sessionRateKey(session)) {
      abort(new ListenerRemoteError(401, 'invalid_access', 'Listener access is invalid or expired.'));
    }
  }, checkMs);
  if (req.aborted || req.res?.destroyed || req.socket?.destroyed) onClose();
  else {
    req.once('aborted', onClose);
    req.once('close', onClose);
    req.res?.once('close', onClose);
    req.socket?.once('close', onClose);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      clearInterval(sessionCheck);
      req.off('aborted', onClose);
      req.off('close', onClose);
      req.res?.off('close', onClose);
      req.socket?.off('close', onClose);
    },
  };
}

async function cachedOrSearch(
  req: Request,
  runtime: SearchRuntime,
  binding: ListenerRemoteBinding,
  query: string,
  session: string,
): Promise<CachedTrack[]> {
  const now = runtime.now();
  pruneQueryCache(runtime, now);
  const cacheKey = normalizeQuery(query);
  const hit = runtime.queryCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.tracks;

  const identity = identityKey(binding);
  beginProviderSearch(runtime, identity, binding.serverConfigId);
  const { signal, dispose } = openSearchSignal(req, session);
  try {
    const deps = searchDeps(req);
    let rows: ListenerSearchResult[];
    try {
      rows = deps
        ? await searchListenerMusic(query, MAX_RESULTS, signal, deps)
        : await searchListenerMusic(query, MAX_RESULTS, signal);
    } catch (err) {
      if (err instanceof ListenerRemoteError) throw err;
      if (signal.aborted && signal.reason instanceof ListenerRemoteError) throw signal.reason;
      fail(503, 'unavailable', 'Listener remote is unavailable.');
    }
    signal.throwIfAborted();

    const tracks = rows.map(toCachedTrack).filter((row): row is CachedTrack => row !== null).slice(0, MAX_RESULTS);
    runtime.queryCache.delete(cacheKey);
    runtime.queryCache.set(cacheKey, { tracks, expiresAt: runtime.now() + QUERY_CACHE_TTL_MS });
    pruneQueryCache(runtime, runtime.now());
    return tracks;
  } finally {
    dispose();
    endProviderSearch(runtime, identity, binding.serverConfigId);
  }
}

/** Search music and queue a chosen result (`POST /search`, `POST /search/queue`). */
export function registerSearchRoutes(router: Router): void {
  router.post('/search', endpoint(async (req, res) => {
    const { query: raw } = body(req, z.object({ query: z.string().max(200) }).strict());
    const query = parseSearchQuery(raw);
    const { binding } = await authorized(req, 'add', 'request');
    const session = bearer(req);
    const runtime = runtimeFor(req);
    hitSearchRate(runtime, identityKey(binding));
    const tracks = await cachedOrSearch(req, runtime, binding, query, session);
    await authenticate(req);
    const payload: ListenerRemoteSearchResponse = issueResults(runtime, binding, tracks);
    res.json(payload);
  }));

  router.post('/search/queue', endpoint(async (req, res) => {
    const { resultId } = body(req, z.object({ resultId: z.string().regex(RESULT_ID) }).strict());
    const arrival = arrivalSnapshot(req);
    const binding = await authenticate(req);
    const runtime = runtimeFor(req);
    const track = claimResult(runtime, binding, resultId);
    const link = listenerLink(req, binding, track.url);
    try {
      await appendForListener(
        req,
        binding,
        async () => {
          const item = await link.resolve();
          const verdict = checkListenerDuration({
            durationSec: item.duration,
            isLive: Boolean(item.streamUrl),
          });
          if (!verdict.ok) refuseDuration(verdict.reason);
          return item;
        },
        'listener.remote.search_queue',
        arrival,
        () => link.check(),
      );
    } finally {
      link.dispose();
    }
    res.json({ ok: true });
  }));
}
