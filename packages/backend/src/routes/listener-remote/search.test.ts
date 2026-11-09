import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import express from 'express';
import { listenerRemoteIpGuard, listenerRemoteRoutes } from '../listener-remote.routes.js';
import { ListenerRemoteService } from '../../voice/listener-remote.js';
import { defaultMediaCommandPermissions } from '../../voice/media-command-permissions.js';
import { PlayQueue, type QueueItem } from '../../voice/playlist/queue.js';
import { MediaSessionConflictError } from '../../voice/media-session.js';
import { ListenerRemoteRefusalAudit } from '../../audit/listener-remote-refusals.js';
import type { ListenerSearchResult } from '../../voice/audio/listener-music.js';

const binding = {
  botId: 4, serverConfigId: 2, virtualServerId: 3, channelId: 8, clid: 9, uid: 'listener-secret-identity',
};
const otherBinding = { ...binding, uid: 'other-listener-identity', clid: 10 };
/** Different TeamSpeak serverConfigId; channel stays fixture-aligned for live validation. */
const serverBBinding = {
  ...binding, uid: 'server-b-listener', clid: 12, serverConfigId: 7,
};
const mediaUrl = 'https://8.8.8.8/media?id=secret-search';
const item: QueueItem = {
  id: 'song-11', title: 'Visible title', artist: 'Visible artist', duration: 123,
  filePath: '/private/music/credential.mp3', source: 'url', sourceUrl: mediaUrl,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Wait until AbortSignal fires, or fail after `ms` so CI cannot hang. */
function waitUntilAborted(signal: AbortSignal | undefined, ms = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`provider did not abort within ${ms}ms`)), ms);
    const finish = (err?: unknown) => {
      clearTimeout(timer);
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    };
    if (!signal) {
      finish(new Error('missing abort signal'));
      return;
    }
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener('abort', () => finish(), { once: true });
  });
}

/** Poll until `fn` succeeds or `ms` elapses (bounded slot-free checks). */
async function eventually(fn: () => Promise<void>, ms = 1_000, step = 20): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await fn();
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, step));
    }
  }
  throw last instanceof Error ? last : new Error(`eventually timed out: ${String(last)}`);
}

function dumpRow(partial: Partial<ListenerSearchResult> & Pick<ListenerSearchResult, 'id' | 'title'>): ListenerSearchResult {
  return {
    artist: 'Artist',
    durationSec: 180,
    thumbnail: 'https://img.example/t.jpg',
    url: `https://www.youtube.com/watch?v=${partial.id}`,
    ...partial,
  };
}

async function hangUntilAborted(signal: AbortSignal | undefined, started?: { resolve: () => void }): Promise<never> {
  started?.resolve();
  await waitUntilAborted(signal);
  throw signal?.reason ?? new Error('aborted');
}

function youtubeOkStdout(title: string): string {
  return JSON.stringify({ id: 'FGBhQbmPwH8', title, artists: ['Band'], duration: 200 });
}

async function fixture() {
  let now = 1_000_000;
  const remote = new ListenerRemoteService(() => now);
  const queue = new PlayQueue();
  queue.add(item);
  const state = {
    uid: binding.uid, channelId: binding.channelId, groups: '7',
    policy: null as string | null, botChannel: binding.channelId,
    botServer: binding.serverConfigId, databaseServer: binding.serverConfigId,
    virtualServer: binding.virtualServerId, botStatus: 'playing' as string,
    video: null as { id: string; state: string } | null,
    playGate: null as (() => Promise<void>) | null,
  };
  const audit: Record<string, unknown>[] = [];
  let downloads = 0;
  let searchCalls = 0;
  let searchImpl: (query: string, signal?: AbortSignal) => Promise<ListenerSearchResult[]> = async () => [
    dumpRow({ id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', durationSec: 355 }),
    dumpRow({ id: 'dQw4w9WgXcQ', title: 'Rick Live', durationSec: null }),
    dumpRow({ id: 'aaaaaaaaaaa', title: 'Too Long', durationSec: 901 }),
    dumpRow({ id: 'bbbbbbbbbbb', title: 'Ok Song', artist: 'Band', durationSec: 200 }),
  ];
  let dumpOverride: ((signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>) | null = null;
  let youtubeDump:
    | ((query: string, signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>)
    | null = null;
  let youtubeCalls = 0;
  const start = async (started: QueueItem) => {
    if (state.botStatus !== 'connected') return;
    state.botStatus = 'playing';
    bot.nowPlaying = started;
    await state.playGate?.();
    if (state.botStatus !== 'playing') bot.nowPlaying = null;
  };
  const bot = {
    currentConfig: { id: binding.botId, serverConfigId: binding.serverConfigId, name: 'Music bot', password: 'bot-secret' },
    ts3ClientId: 99, stopGeneration: 0,
    get status() { return state.botStatus; },
    getCurrentChannelId: () => state.botChannel,
    nowPlaying: item as QueueItem | null, queue,
    videoSessionInfo: () => state.video as any,
    assertMusicCanStart(ids: string[] | undefined) {
      const video = state.video;
      if (video && !ids?.includes(video.id)) throw new MediaSessionConflictError('music', [video as any]);
    },
    play: (started: QueueItem) => start(started),
    playStream: (started: QueueItem) => start(started),
  };
  Object.defineProperty(bot.currentConfig, 'serverConfigId', { get: () => state.botServer });
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.locals.listenerRemote = remote;
  app.locals.listenerRemoteSearchNow = () => now;
  // C1a probe must not call real yt-dlp in route tests.
  app.locals.listenerLinkProbe = async () => ({ durationSec: item.duration ?? 180 });
  app.locals.listenerRemoteSearchSessionCheckMs = 50;
  app.locals.listenerMusicSearchDeps = {
    dumpMusicSearch: async (query: string, _maxResults?: number, signal?: AbortSignal) => {
      searchCalls++;
      if (dumpOverride) return dumpOverride(signal);
      const rows = await searchImpl(query, signal);
      return {
        code: 0,
        stdout: rows.map((row) => JSON.stringify({
          id: row.id, title: row.title, artists: [row.artist], duration: row.durationSec ?? 0, thumbnail: row.thumbnail,
          is_live: row.isLive === true, live_status: row.liveStatus ?? undefined,
        })).join('\n'),
        stderr: '',
      };
    },
    // Always stub the YouTube fallback so route tests never spawn yt-dlp.
    dumpYouTubeSearch: async (query: string, _maxResults?: number, signal?: AbortSignal) => {
      youtubeCalls++;
      if (youtubeDump) return youtubeDump(query, signal);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  app.locals.voiceBotManager = { getBot: () => bot, getBotsForServer: async () => [{ bot }] };
  const roster = [
    { clid: binding.clid, uid: binding.uid },
    { clid: otherBinding.clid, uid: otherBinding.uid },
    { clid: serverBBinding.clid, uid: serverBBinding.uid },
    { clid: 11, uid: 'third-listener' },
  ];
  app.locals.eventBridge = {
    executeCommand: async (_server: number, _virtualServer: number, cmd: string) => {
      if (cmd.startsWith('clientinfo')) {
        const clid = Number(/clid=(\d+)/.exec(cmd)?.[1]);
        const row = roster.find((entry) => entry.clid === clid) ?? { clid, uid: state.uid };
        return `cid=${state.channelId} client_unique_identifier=${row.uid} client_servergroups=${state.groups} client_type=0\nerror id=0 msg=ok`;
      }
      return `${roster.map((row) =>
        `clid=${row.clid} cid=${state.channelId} client_unique_identifier=${row.uid} client_type=0`
      ).join('|')}\nerror id=0 msg=ok`;
    },
  };
  app.locals.prisma = {
    appSetting: {
      findUnique: async () => (state.policy === null ? null : { value: state.policy }),
    },
    musicBot: { findUnique: async () => ({ serverConfigId: state.databaseServer, virtualServerId: state.virtualServer }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      musicRequest: {
        upsert: async () => ({}),
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
      },
    }),
    song: {
      findMany: async () => [],
      findFirst: async () => ({ ...item, id: 11 }),
    },
    adminAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return { id: 'audit-event' };
      },
      updateMany: async (query: Record<string, unknown>) => {
        audit.push(query);
        return { count: 1 };
      },
      createMany: async () => ({ count: 0 }),
    },
  };
  app.locals.listenerRemoteRefusals = new ListenerRemoteRefusalAudit(app.locals.prisma, { log: () => undefined });
  let downloadGate: { started: ReturnType<typeof deferred<void>>; gate: ReturnType<typeof deferred<void>> } | null = null;
  app.locals.mediaUrlPipelineDeps = {
    resolveSpotify: async (url: string) => url,
    resolveAppleMusic: async () => ({ tracks: [] }),
    resolveSpotifyCollection: async () => null,
    appleTrackToYouTube: async () => null,
    expandYouTube: async () => null,
    downloadTrack: async () => {
      downloads++;
      if (downloadGate) {
        downloadGate.started.resolve();
        await downloadGate.gate.promise;
      }
      return { ...item, sourceUrl: mediaUrl };
    },
  };
  app.use('/api/listener-remote', listenerRemoteIpGuard, listenerRemoteRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/listener-remote`;
  const request = (path: string, options: { body?: unknown; session?: string; method?: string } = {}) =>
    fetch(`${base}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.session ? { Authorization: `Bearer ${options.session}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  const exchange = async (bound = binding) => {
    const issued = remote.issue(bound);
    const response = await request('/exchange', { body: { token: issued.token } });
    assert.equal(response.status, 200);
    const { credentialsFromExchange } = await import('./cookie-test-util.js');
    return credentialsFromExchange(response);
  };
  return {
    request, exchange, queue, state, audit, bot, remote, app, base,
    get downloads() { return downloads; },
    get searchCalls() { return searchCalls; },
    get youtubeCalls() { return youtubeCalls; },
    setSearch: (fn: typeof searchImpl) => { searchImpl = fn; },
    setDumpFailure: (stderr: string) => {
      dumpOverride = async () => ({ code: 1, stdout: '', stderr });
    },
    setYouTubeDump: (
      fn: (query: string, signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>,
    ) => { youtubeDump = fn; },
    armDownloadGate: () => {
      downloadGate = { started: deferred<void>(), gate: deferred<void>() };
      return downloadGate;
    },
    advance: (ms: number) => { now += ms; },
    restrict: (groups: number[] = []) => {
      state.policy = JSON.stringify({
        ...defaultMediaCommandPermissions(),
        queue: { mode: 'server_groups', serverGroupIds: groups },
      });
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    }),
  };
}

async function using(fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await fn(f); } finally { await f.close(); }
}

describe('listener remote search (C2)', () => {
  it('returns filtered results with opaque ids and never exposes source URLs', async () => using(async f => {
    const { session } = await f.exchange();
    const response = await f.request('/search', { session, body: { query: 'bohemian' } });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      results: Array<Record<string, unknown>>;
      expiresAt: string;
    };
    assert.equal(body.results.length, 2);
    assert.deepEqual(body.results.map(r => r.title).sort(), ['Bohemian Rhapsody', 'Ok Song']);
    for (const row of body.results) {
      assert.match(String(row.id), /^[A-Za-z0-9_-]{22}$/);
      assert.equal(typeof row.duration, 'number');
      assert.ok(!('url' in row));
      assert.ok(!('thumbnail' in row));
      assert.ok(!('sourceUrl' in row));
      assert.ok(!JSON.stringify(row).includes('youtube'));
    }
    assert.ok(Number.isFinite(Date.parse(body.expiresAt)));
    assert.equal(f.searchCalls, 1);
    assert.deepEqual(f.audit, []);
  }));

  it('omits confirmed live rows even when they report a positive duration', async () => using(async f => {
    f.setSearch(async () => [
      dumpRow({ id: 'fJ9rUzIMcZQ', title: 'Safe Song', durationSec: 200 }),
      dumpRow({ id: 'dQw4w9WgXcQ', title: 'Live Concert', durationSec: 240, isLive: true }),
      dumpRow({ id: 'bbbbbbbbbbb', title: 'Also Live', durationSec: 90, liveStatus: 'is_live' }),
    ]);
    const { session } = await f.exchange();
    const response = await f.request('/search', { session, body: { query: 'live-filter' } });
    assert.equal(response.status, 200);
    const body = await response.json() as { results: Array<{ title: string }> };
    assert.deepEqual(body.results.map((row) => row.title), ['Safe Song']);
  }));

  it('falls back to YouTube search when Music rows lack duration, then filters live/too-long', async () => using(async f => {
    // C5: Music flat extract succeeds with duration=null → empty without fallback.
    f.setSearch(async () => [
      dumpRow({ id: 'musicnull01', title: 'Daft Punk One More Time', durationSec: null }),
      dumpRow({ id: 'musicnull02', title: 'One More Time Radio', durationSec: null }),
    ]);
    f.setYouTubeDump(async () => ({
      code: 0,
      stdout: [
        dumpRow({ id: 'FGBhQbmPwH8', title: 'One More Time', artist: 'Daft Punk', durationSec: 320 }),
        dumpRow({ id: 'liveconcert', title: 'Live Concert', durationSec: 240, isLive: true }),
        dumpRow({ id: 'toolonggggg', title: 'Hour Mix', durationSec: 3600 }),
        dumpRow({ id: 'stillnullid', title: 'Still Unknown', durationSec: null }),
      ].map((row) => JSON.stringify({
        id: row.id, title: row.title, artists: [row.artist], duration: row.durationSec ?? 0,
        thumbnail: row.thumbnail, is_live: row.isLive === true, live_status: row.liveStatus ?? undefined,
      })).join('\n'),
      stderr: '',
    }));
    const { session } = await f.exchange();
    const response = await f.request('/search', { session, body: { query: 'Daft Punk One More Time' } });
    assert.equal(response.status, 200);
    const body = await response.json() as { results: Array<{ title: string; duration: number }> };
    assert.equal(f.youtubeCalls, 1);
    assert.deepEqual(body.results.map((row) => row.title), ['One More Time']);
    assert.equal(body.results[0]!.duration, 320);
  }));

  it('returns empty results when Music and YouTube both lack verified duration', async () => using(async f => {
    f.setSearch(async () => [
      dumpRow({ id: 'musicnull01', title: 'Unknown Music', durationSec: null }),
    ]);
    f.setYouTubeDump(async () => ({
      code: 0,
      stdout: JSON.stringify({
        id: 'stillnullid', title: 'Unknown YT', artists: ['x'], duration: 0,
      }),
      stderr: '',
    }));
    const { session } = await f.exchange();
    const response = await f.request('/search', { session, body: { query: 'both-unusable' } });
    assert.equal(response.status, 200);
    const body = await response.json() as { results: unknown[] };
    assert.deepEqual(body.results, []);
    assert.equal(f.youtubeCalls, 1);
  }));

  it('returns 503 when Music lacks duration and YouTube fallback fails', async () => using(async f => {
    // Owner decision (#639): Music HTTP-success with unusable rows + YouTube dump
    // failure is provider unavailability (503), not soft empty 200 [].
    f.setSearch(async () => [
      dumpRow({ id: 'musicnull01', title: 'Unknown Music', durationSec: null }),
    ]);
    f.setYouTubeDump(async () => ({
      code: 1,
      stdout: '',
      stderr: 'ERROR: youtube-fallback-down credential-must-not-leak',
    }));
    const { session } = await f.exchange();
    const response = await f.request('/search', { session, body: { query: 'music-ok-youtube-fail' } });
    assert.equal(response.status, 503);
    const body = await response.json() as { error: string; code: string };
    assert.deepEqual(body, { error: 'Listener remote is unavailable.', code: 'unavailable' });
    assert.ok(!JSON.stringify(body).includes('credential'));
    assert.equal(f.youtubeCalls, 1);
  }));

  it('binds result ids to the searching identity and hides cross-listener reuse', async () => using(async f => {
    const first = await f.exchange();
    const search = await f.request('/search', { session: first.session, body: { query: 'queen' } });
    assert.equal(search.status, 200);
    const { results } = await search.json() as { results: Array<{ id: string }> };
    const resultId = results[0]!.id;

    const other = await f.exchange(otherBinding);
    const stolen = await f.request('/search/queue', { session: other.session, body: { resultId } });
    assert.equal(stolen.status, 404);
    assert.deepEqual(await stolen.json(), { error: 'Search result not found.', code: 'not_found' });
    assert.equal(f.downloads, 0);

    assert.equal((await f.request('/search/queue', { session: first.session, body: { resultId } })).status, 200);
    assert.equal(f.downloads, 1);
    assert.equal(f.audit[0]?.action, 'listener.remote.search_queue');
  }));

  it('expires, replaces and consumes result ids with the same 404', async () => using(async f => {
    const { session } = await f.exchange();
    const first = await f.request('/search', { session, body: { query: 'one' } });
    const { results } = await first.json() as { results: Array<{ id: string }> };
    const expiredId = results[0]!.id;

    f.advance(5 * 60_000 + 1);
    assert.deepEqual(await (await f.request('/search/queue', { session, body: { resultId: expiredId } })).json(), {
      error: 'Search result not found.', code: 'not_found',
    });

    const second = await f.request('/search', { session, body: { query: 'two' } });
    const replaced = await second.json() as { results: Array<{ id: string }> };
    assert.deepEqual(await (await f.request('/search/queue', { session, body: { resultId: expiredId } })).json(), {
      error: 'Search result not found.', code: 'not_found',
    });

    const kept = replaced.results[0]!.id;
    assert.equal((await f.request('/search/queue', { session, body: { resultId: kept } })).status, 200);
    assert.deepEqual(await (await f.request('/search/queue', { session, body: { resultId: kept } })).json(), {
      error: 'Search result not found.', code: 'not_found',
    });
  }));

  it('clears search results on lifecycle revoke and when a new grant replaces the old one', async () => using(async f => {
    const first = await f.exchange();
    const search = await f.request('/search', { session: first.session, body: { query: 'revoke-clear' } });
    const { results } = await search.json() as { results: Array<{ id: string }> };
    const resultId = results[0]!.id;

    // Lifecycle revoke (disconnect / departure) — not only DELETE /session.
    assert.equal(f.remote.revoke(binding.botId, binding.uid), 1);
    const reissued = await f.exchange();
    assert.deepEqual(await (await f.request('/search/queue', {
      session: reissued.session, body: { resultId },
    })).json(), { error: 'Search result not found.', code: 'not_found' });

    const again = await f.request('/search', { session: reissued.session, body: { query: 'replace-clear' } });
    const { results: next } = await again.json() as { results: Array<{ id: string }> };
    const keptId = next[0]!.id;
    // New !remote for the same identity replaces the grant and invalidates prior ids.
    const replacedGrant = await f.exchange();
    assert.deepEqual(await (await f.request('/search/queue', {
      session: replacedGrant.session, body: { resultId: keptId },
    })).json(), { error: 'Search result not found.', code: 'not_found' });

    // Unaffected other identity keeps its own results.
    const other = await f.exchange(otherBinding);
    const otherSearch = await f.request('/search', { session: other.session, body: { query: 'other-keep' } });
    const { results: otherResults } = await otherSearch.json() as { results: Array<{ id: string }> };
    f.remote.revoke(binding.botId, binding.uid);
    assert.equal((await f.request('/search/queue', {
      session: other.session, body: { resultId: otherResults[0]!.id },
    })).status, 200);
  }));

  it('rate-limits searches per identity and applies per-server provider fairness', async () => using(async f => {
    const a = await f.exchange();
    for (let i = 0; i < 5; i++) {
      assert.equal((await f.request('/search', { session: a.session, body: { query: `q${i}` } })).status, 200);
    }
    const limited = await f.request('/search', { session: a.session, body: { query: 'q6' } });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json() as { code: string }).code, 'rate_limited');
    assert.ok(limited.headers.get('retry-after'));

    f.advance(60_000);
    const started = deferred<void>();
    const gate = deferred<void>();
    f.setSearch(async () => {
      started.resolve();
      await gate.promise;
      return [dumpRow({ id: 'ccccccccccc', title: 'Slow', durationSec: 120 })];
    });
    const pending = f.request('/search', { session: a.session, body: { query: 'slow-a' } });
    await started.promise;
    assert.equal((await f.request('/search', { session: a.session, body: { query: 'slow-b' } })).status, 429);

    // Same TeamSpeak server cannot take a second provider slot while the first is held.
    const b = await f.exchange(otherBinding);
    assert.equal((await f.request('/search', { session: b.session, body: { query: 'slow-other' } })).status, 429);

    const cached = await f.request('/search', { session: b.session, body: { query: 'q0' } });
    assert.equal(cached.status, 200, 'cache hits must not require a provider slot');

    gate.resolve();
    assert.equal((await pending).status, 200);
    assert.equal((await f.request('/search', { session: b.session, body: { query: 'after-free' } })).status, 200);
  }));

  it('claims a result id before queueing so a concurrent peer gets 404', async () => using(async f => {
    const { session } = await f.exchange();
    const search = await f.request('/search', { session, body: { query: 'claim' } });
    const { results } = await search.json() as { results: Array<{ id: string }> };
    const resultId = results[0]!.id;
    const gate = f.armDownloadGate();
    const first = f.request('/search/queue', { session, body: { resultId } });
    await gate.started.promise;
    const second = await f.request('/search/queue', { session, body: { resultId } });
    assert.equal(second.status, 404);
    assert.deepEqual(await second.json(), { error: 'Search result not found.', code: 'not_found' });
    gate.gate.resolve();
    assert.equal((await first).status, 200);
    assert.equal(f.downloads, 1);
    assert.equal(f.audit.filter((row) => row.action === 'listener.remote.search_queue').length, 1);
  }));

  it('does not restore a claimed result after a failed queue attempt', async () => using(async f => {
    const { session } = await f.exchange();
    const search = await f.request('/search', { session, body: { query: 'fail-closed' } });
    const { results } = await search.json() as { results: Array<{ id: string }> };
    const resultId = results[0]!.id;
    for (let i = 0; i < 500; i++) f.queue.add({ ...item, id: `filler-${i}` });
    assert.equal((await f.request('/search/queue', { session, body: { resultId } })).status, 409);
    assert.equal(f.downloads, 0);
    assert.deepEqual(await (await f.request('/search/queue', { session, body: { resultId } })).json(), {
      error: 'Search result not found.', code: 'not_found',
    });
  }));

  it('cancels an in-flight provider search when the session is revoked and frees the slot', async () => using(async f => {
    const a = await f.exchange();
    f.advance(60_000);
    const started = deferred<void>();
    let hangOnce = true;
    f.setSearch(async (_query, signal) => {
      if (!hangOnce) {
        return [dumpRow({ id: 'eeeeeeeeeee', title: 'After', durationSec: 100 })];
      }
      hangOnce = false;
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason ?? new Error('aborted'));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return [dumpRow({ id: 'ccccccccccc', title: 'Slow', durationSec: 120 })];
    });
    const pending = f.request('/search', { session: a.session, body: { query: 'revoke-mid-search' } });
    await started.promise;
    f.remote.revoke(binding.botId, binding.uid);
    const cancelled = await pending;
    assert.ok([401, 503, 504].includes(cancelled.status), `expected cancel status, got ${cancelled.status}`);

    const b = await f.exchange(otherBinding);
    const after = await f.request('/search', { session: b.session, body: { query: 'slot-free' } });
    assert.equal(after.status, 200, 'provider slot must be released after search cancellation');
  }));

  it('search queue uses the C1a probe before download', async () => using(async f => {
    const { session } = await f.exchange();
    const search = await f.request('/search', { session, body: { query: 'probe' } });
    const { results } = await search.json() as { results: Array<{ id: string }> };
    let probes = 0;
    f.app.locals.listenerLinkProbe = async () => {
      probes++;
      return { durationSec: 1200 };
    };
    const response = await f.request('/search/queue', { session, body: { resultId: results[0]!.id } });
    assert.equal(response.status, 422);
    assert.equal((await response.json() as { code: string }).code, 'too_long');
    assert.equal(probes, 1);
    assert.equal(f.downloads, 0);
  }));

  it('reuses the query cache without sharing result ids across listeners', async () => using(async f => {
    const a = await f.exchange();
    const first = await f.request('/search', { session: a.session, body: { query: '  Same Query ' } });
    assert.equal(first.status, 200);
    assert.equal(f.searchCalls, 1);
    const aBody = await first.json() as { results: Array<{ id: string }> };

    const b = await f.exchange(otherBinding);
    const second = await f.request('/search', { session: b.session, body: { query: 'same query' } });
    assert.equal(second.status, 200);
    assert.equal(f.searchCalls, 1, 'normalized query hits the process cache');
    const bBody = await second.json() as { results: Array<{ id: string }> };
    assert.notEqual(aBody.results[0]!.id, bBody.results[0]!.id);

    assert.equal((await f.request('/search/queue', { session: a.session, body: { resultId: aBody.results[0]!.id } })).status, 200);
    assert.equal((await f.request('/search/queue', { session: b.session, body: { resultId: bBody.results[0]!.id } })).status, 200);
  }));

  it('preserves queue_full on search queue and denies without queue permission', async () => using(async f => {
    const { session } = await f.exchange();
    f.restrict([8]);
    assert.equal((await f.request('/search', { session, body: { query: 'denied' } })).status, 403);
    assert.equal(f.searchCalls, 0);

    f.state.policy = null;
    const search = await f.request('/search', { session, body: { query: 'fill' } });
    const { results } = await search.json() as { results: Array<{ id: string }> };
    for (let i = 0; i < 500; i++) f.queue.add({ ...item, id: `filler-${i}` });
    const full = await f.request('/search/queue', { session, body: { resultId: results[0]!.id } });
    assert.equal(full.status, 409);
    assert.deepEqual(await full.json(), { error: 'The queue is full.', code: 'queue_full' });
    assert.equal(f.downloads, 0);
    assert.deepEqual(f.audit, []);
  }));

  it('revokes the session during search queue like other queue paths', async () => using(async f => {
    const { session } = await f.exchange();
    const search = await f.request('/search', { session, body: { query: 'revoke' } });
    const { results } = await search.json() as { results: Array<{ id: string }> };
    const gate = f.armDownloadGate();
    const pending = f.request('/search/queue', { session, body: { resultId: results[0]!.id } });
    await gate.started.promise;
    f.state.channelId = 99;
    gate.gate.resolve();
    assert.equal((await pending).status, 401);
  }));

  it('refuses invalid queries and maps resolver failures to 503 without echoing internals', async () => using(async f => {
    const { session } = await f.exchange();
    for (const query of ['', 'a', 'x'.repeat(101), 'https://evil.example/x', 'http://x', 'bad\nquery', '-flag']) {
      const response = await f.request('/search', { session, body: { query } });
      assert.equal(response.status, 400, query);
      assert.equal((await response.json() as { code: string }).code, 'invalid_request');
    }
    assert.equal(f.searchCalls, 0);

    f.setDumpFailure('ERROR: credential-must-not-leak Sign in to confirm you are not a bot');
    f.setYouTubeDump(async () => ({
      code: 1,
      stdout: '',
      stderr: 'ERROR: youtube-also-down credential-must-not-leak',
    }));
    const failed = await f.request('/search', { session, body: { query: 'provider-down' } });
    assert.equal(failed.status, 503);
    const body = await failed.json() as { error: string; code: string };
    assert.deepEqual(body, { error: 'Listener remote is unavailable.', code: 'unavailable' });
    assert.ok(!JSON.stringify(body).includes('credential'));
    assert.ok(!JSON.stringify(body).includes('Sign in'));
    assert.equal(f.youtubeCalls, 1);
  }));

  it('re-checks duration on queue and refuses with 422 when the provider answer changed', async () => using(async f => {
    const { session } = await f.exchange();
    const search = await f.request('/search', { session, body: { query: 'duration' } });
    const { results } = await search.json() as { results: Array<{ id: string }> };
    f.app.locals.mediaUrlPipelineDeps.downloadTrack = async () => ({
      ...item,
      duration: 1200,
      sourceUrl: mediaUrl,
    });
    const before = f.queue.length;
    const response = await f.request('/search/queue', { session, body: { resultId: results[0]!.id } });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: 'This track is longer than 15 minutes.',
      code: 'too_long',
    });
    assert.equal(f.queue.length, before);
  }));

  it('cancels an in-flight provider search when the client disconnects and frees the slot', async () => using(async f => {
    const a = await f.exchange();
    f.advance(60_000);
    const started = deferred<void>();
    let hangOnce = true;
    f.setSearch(async (_query, signal) => {
      if (!hangOnce) return [dumpRow({ id: 'fffffffffff', title: 'After disconnect', durationSec: 100 })];
      hangOnce = false;
      return hangUntilAborted(signal, started);
    });
    const ac = new AbortController();
    const pending = fetch(`${f.base}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.session}` },
      body: JSON.stringify({ query: 'client-disconnect' }),
      signal: ac.signal,
    });
    await started.promise;
    ac.abort();
    await assert.rejects(() => pending, (err: unknown) => err instanceof Error && err.name === 'AbortError');
    const b = await f.exchange(otherBinding);
    await eventually(async () => {
      assert.equal((await f.request('/search', { session: b.session, body: { query: 'after-disconnect' } })).status, 200);
    });
  }));

  it('cancels an in-flight YouTube fallback when the client disconnects and frees the slot', async () => using(async f => {
    const a = await f.exchange();
    f.advance(60_000);
    f.setSearch(async () => [dumpRow({ id: 'musicnull01', title: 'Unknown Music', durationSec: null })]);
    const started = deferred<void>();
    f.setYouTubeDump(async (_query, signal) => hangUntilAborted(signal, started));
    const ac = new AbortController();
    const pending = fetch(`${f.base}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.session}` },
      body: JSON.stringify({ query: 'fallback-disconnect' }),
      signal: ac.signal,
    });
    await started.promise;
    ac.abort();
    await assert.rejects(() => pending, (err: unknown) => err instanceof Error && err.name === 'AbortError');
    const b = await f.exchange(otherBinding);
    f.setYouTubeDump(async () => ({ code: 0, stdout: youtubeOkStdout('After fallback disconnect'), stderr: '' }));
    await eventually(async () => {
      assert.equal((await f.request('/search', { session: b.session, body: { query: 'after-fallback-disconnect' } })).status, 200);
    });
  }));

  it('times out a stalled provider search and frees the slot', async () => using(async f => {
    const a = await f.exchange();
    f.advance(60_000);
    f.app.locals.listenerRemoteSearchTimeoutMs = 40;
    const started = deferred<void>();
    let hangOnce = true;
    f.setSearch(async (_query, signal) => {
      if (!hangOnce) return [dumpRow({ id: 'ggggggggggg', title: 'After timeout', durationSec: 100 })];
      hangOnce = false;
      return hangUntilAborted(signal, started);
    });
    const timedOut = await f.request('/search', { session: a.session, body: { query: 'provider-timeout' } });
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json() as { code: string }).code, 'timeout');
    const b = await f.exchange(otherBinding);
    assert.equal((await f.request('/search', { session: b.session, body: { query: 'after-timeout' } })).status, 200);
  }));

  it('times out a stalled YouTube fallback after Music lacks duration and frees the slot', async () => using(async f => {
    const a = await f.exchange();
    f.advance(60_000);
    f.app.locals.listenerRemoteSearchTimeoutMs = 40;
    f.setSearch(async () => [dumpRow({ id: 'musicnull01', title: 'Unknown Music', durationSec: null })]);
    f.setYouTubeDump(async (_query, signal) => hangUntilAborted(signal));
    const timedOut = await f.request('/search', { session: a.session, body: { query: 'fallback-timeout' } });
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json() as { code: string }).code, 'timeout');
    assert.equal(f.youtubeCalls, 1);
    const b = await f.exchange(otherBinding);
    f.setYouTubeDump(async () => ({ code: 0, stdout: youtubeOkStdout('After fallback timeout'), stderr: '' }));
    assert.equal((await f.request('/search', { session: b.session, body: { query: 'after-fallback-timeout' } })).status, 200);
  }));

  it('allows a simultaneous provider search on another TeamSpeak server under global capacity', async () => using(async f => {
    const a = await f.exchange();
    f.advance(60_000);
    const started = deferred<void>();
    const gate = deferred<void>();
    let slowCalls = 0;
    f.setSearch(async (query, signal) => {
      if (query === 'server-a-slow') {
        slowCalls++;
        started.resolve();
        await Promise.race([
          gate.promise,
          waitUntilAborted(signal).then(() => { throw signal?.reason ?? new Error('aborted'); }),
        ]);
        return [dumpRow({ id: 'hhhhhhhhhhh', title: 'Server A', durationSec: 120 })];
      }
      return [dumpRow({ id: 'iiiiiiiiiii', title: `Server B ${query}`, durationSec: 90 })];
    });
    const pendingA = f.request('/search', { session: a.session, body: { query: 'server-a-slow' } });
    await started.promise;
    try {
      assert.equal((await f.request('/search', { session: a.session, body: { query: 'server-a-peer' } })).status, 429);
      // Retarget the fixture bot/DB row so live identity accepts server B's binding.
      f.state.botServer = serverBBinding.serverConfigId;
      f.state.databaseServer = serverBBinding.serverConfigId;
      const b = await f.exchange(serverBBinding);
      const serverB = await f.request('/search', { session: b.session, body: { query: 'server-b-ok' } });
      const serverBBody = await serverB.json() as { results: unknown[] };
      assert.equal(serverB.status, 200, `unrelated server starved: ${JSON.stringify(serverBBody)}`);
      assert.equal(serverBBody.results.length, 1);
    } finally {
      // Restore before releasing server A — search re-authenticates after the provider returns.
      f.state.botServer = binding.serverConfigId;
      f.state.databaseServer = binding.serverConfigId;
      gate.resolve();
    }
    assert.equal((await pendingA).status, 200);
    assert.equal(slowCalls, 1);
  }));
});

