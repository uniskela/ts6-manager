import { createHash, randomBytes } from 'node:crypto';
import type { Router } from 'express';
import { z } from 'zod';
import type { ListenerRemoteSearchResponse, ListenerRemoteSearchResult } from '@ts6/common';
import { RateWindows, monotonicNow } from '../../utils/rate-windows.js';
import {
  checkListenerDuration,
  searchListenerMusic,
  type ListenerMusicSearchDeps,
  type ListenerSearchResult,
} from '../../voice/audio/listener-music.js';
import {
  ListenerRemoteError,
  type Binding as ListenerRemoteBinding,
  type ListenerRemoteService,
} from '../../voice/listener-remote.js';
import { appendForListener, arrivalSnapshot } from './append.js';
import { listenerLink } from './link.js';
import { authenticate, authorized, body, endpoint, fail, service } from './shared.js';

const RESULT_TTL_MS = 5 * 60_000;
const QUERY_CACHE_TTL_MS = 10 * 60_000;
const QUERY_CACHE_MAX = 200;
const SEARCH_RATE_WINDOW_MS = 60_000;
const SEARCHES_PER_MINUTE = 5;
const MAX_RESULTS = 10;
const MAX_SERVICE_IN_FLIGHT = 2;
const RESULT_ID = /^[A-Za-z0-9_-]{22}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const HTTP_URL = /^https?:\/\//i;

/** Provider row kept only in process memory; never returned to the client. */
interface CachedTrack {
  url: string;
  title: string;
  artist: string | null;
  duration: number;
}

interface QueryCacheEntry {
  tracks: CachedTrack[];
  expiresAt: number;
}

interface IdentityResults {
  byId: Map<string, CachedTrack>;
  expiresAt: number;
}

interface SearchRuntime {
  queryCache: Map<string, QueryCacheEntry>;
  identityResults: Map<string, IdentityResults>;
  searchRates: RateWindows;
  identityInFlight: Set<string>;
  serviceInFlight: number;
  now: () => number;
}

const runtimes = new WeakMap<ListenerRemoteService, SearchRuntime>();

function identityKey(binding: ListenerRemoteBinding): string {
  return createHash('sha256').update(JSON.stringify([binding.botId, binding.uid])).digest('hex');
}

function runtimeFor(req: Parameters<typeof service>[0]): SearchRuntime {
  const remote = service(req);
  let runtime = runtimes.get(remote);
  if (!runtime) {
    const clock = (req.app.locals.listenerRemoteSearchNow as (() => number) | undefined) ?? Date.now;
    runtime = {
      queryCache: new Map(),
      identityResults: new Map(),
      searchRates: new RateWindows(10_000, SEARCH_RATE_WINDOW_MS, clock === Date.now ? monotonicNow : clock),
      identityInFlight: new Set(),
      serviceInFlight: 0,
      now: clock,
    };
    runtimes.set(remote, runtime);
  }
  return runtime;
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

function lookupResult(runtime: SearchRuntime, binding: ListenerRemoteBinding, resultId: string): CachedTrack {
  const now = runtime.now();
  const entry = runtime.identityResults.get(identityKey(binding));
  if (!entry || entry.expiresAt <= now) {
    if (entry) runtime.identityResults.delete(identityKey(binding));
    fail(404, 'not_found', 'Search result not found.');
  }
  const track = entry.byId.get(resultId);
  if (!track) fail(404, 'not_found', 'Search result not found.');
  return track;
}

function consumeResult(runtime: SearchRuntime, binding: ListenerRemoteBinding, resultId: string): void {
  const key = identityKey(binding);
  const entry = runtime.identityResults.get(key);
  entry?.byId.delete(resultId);
  if (entry?.byId.size === 0) runtime.identityResults.delete(key);
}

function issueResults(runtime: SearchRuntime, binding: ListenerRemoteBinding, tracks: CachedTrack[]): {
  results: ListenerRemoteSearchResult[];
  expiresAt: string;
} {
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

function beginSearch(runtime: SearchRuntime, key: string): void {
  const rate = runtime.searchRates.hit(key, [SEARCHES_PER_MINUTE], 0);
  if (rate.count > rate.limit) {
    const retryAfter = Math.max(1, Math.ceil(rate.remainingMs / 1000));
    throw new ListenerRemoteError(429, 'rate_limited', 'Too many remote requests', retryAfter);
  }
  if (runtime.identityInFlight.has(key) || runtime.serviceInFlight >= MAX_SERVICE_IN_FLIGHT) {
    runtime.searchRates.decrement(key, 0);
    fail(429, 'rate_limited', 'Too many remote requests');
  }
  runtime.identityInFlight.add(key);
  runtime.serviceInFlight++;
}

function endSearch(runtime: SearchRuntime, key: string): void {
  runtime.identityInFlight.delete(key);
  runtime.serviceInFlight = Math.max(0, runtime.serviceInFlight - 1);
}

async function cachedOrSearch(
  req: Parameters<typeof service>[0],
  runtime: SearchRuntime,
  query: string,
): Promise<CachedTrack[]> {
  const now = runtime.now();
  pruneQueryCache(runtime, now);
  const cacheKey = normalizeQuery(query);
  const hit = runtime.queryCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.tracks;

  const deps = searchDeps(req);
  let rows: ListenerSearchResult[];
  try {
    rows = deps
      ? await searchListenerMusic(query, MAX_RESULTS, undefined, deps)
      : await searchListenerMusic(query, MAX_RESULTS);
  } catch (err) {
    if (err instanceof ListenerRemoteError) throw err;
    // Resolver/provider failures must not leak stderr or query text.
    fail(503, 'unavailable', 'Listener remote is unavailable.');
  }

  const tracks = rows.map(toCachedTrack).filter((row): row is CachedTrack => row !== null).slice(0, MAX_RESULTS);
  runtime.queryCache.delete(cacheKey);
  runtime.queryCache.set(cacheKey, { tracks, expiresAt: now + QUERY_CACHE_TTL_MS });
  pruneQueryCache(runtime, now);
  return tracks;
}

/** Search music and queue a chosen result (`POST /search`, `POST /search/queue`). */
export function registerSearchRoutes(router: Router): void {
  router.post('/search', endpoint(async (req, res) => {
    const { query: raw } = body(req, z.object({ query: z.string().max(200) }).strict());
    const query = parseSearchQuery(raw);
    const { binding } = await authorized(req, 'add', 'request');
    const runtime = runtimeFor(req);
    const key = identityKey(binding);
    beginSearch(runtime, key);
    try {
      const tracks = await cachedOrSearch(req, runtime, query);
      // Re-check access after the potentially slow provider call.
      await authenticate(req);
      const payload: ListenerRemoteSearchResponse = issueResults(runtime, binding, tracks);
      res.json(payload);
    } finally {
      endSearch(runtime, key);
    }
  }));

  router.post('/search/queue', endpoint(async (req, res) => {
    const { resultId } = body(req, z.object({ resultId: z.string().regex(RESULT_ID) }).strict());
    const arrival = arrivalSnapshot(req);
    const binding = await authenticate(req);
    const runtime = runtimeFor(req);
    const track = lookupResult(runtime, binding, resultId);
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
      consumeResult(runtime, binding, resultId);
    } finally {
      link.dispose();
    }
    res.json({ ok: true });
  }));
}
