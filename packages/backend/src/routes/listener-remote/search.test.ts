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
const mediaUrl = 'https://8.8.8.8/media?id=secret-search';
const item: QueueItem = {
  id: 'song-11', title: 'Visible title', artist: 'Visible artist', duration: 123,
  filePath: '/private/music/credential.mp3', source: 'url', sourceUrl: mediaUrl,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
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
  let searchImpl: (query: string) => Promise<ListenerSearchResult[]> = async () => [
    dumpRow({ id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', durationSec: 355 }),
    dumpRow({ id: 'dQw4w9WgXcQ', title: 'Rick Live', durationSec: null }),
    dumpRow({ id: 'aaaaaaaaaaa', title: 'Too Long', durationSec: 901 }),
    dumpRow({ id: 'bbbbbbbbbbb', title: 'Ok Song', artist: 'Band', durationSec: 200 }),
  ];
  let dumpOverride: (() => Promise<{ code: number | null; stdout: string; stderr: string }>) | null = null;
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
  app.locals.listenerMusicSearchDeps = {
    dumpMusicSearch: async (query: string) => {
      searchCalls++;
      if (dumpOverride) return dumpOverride();
      const rows = await searchImpl(query);
      return {
        code: 0,
        stdout: rows.map((row) => JSON.stringify({
          id: row.id, title: row.title, artists: [row.artist], duration: row.durationSec ?? 0, thumbnail: row.thumbnail,
        })).join('\n'),
        stderr: '',
      };
    },
  };
  app.locals.voiceBotManager = { getBot: () => bot, getBotsForServer: async () => [{ bot }] };
  const roster = [
    { clid: binding.clid, uid: binding.uid },
    { clid: otherBinding.clid, uid: otherBinding.uid },
    { clid: 11, uid: 'third-listener' },
  ];
  app.locals.eventBridge = {
    executeCommand: async (_server: number, _virtualServer: number, cmd: string) => {
      if (cmd.startsWith('clientinfo')) {
        const clid = Number(/clid=(\d+)/.exec(cmd)?.[1]);
        const row = roster.find((entry) => entry.clid === clid) ?? { clid, uid: state.uid };
        return `client_unique_identifier=${row.uid} client_servergroups=${state.groups} client_type=0\nerror id=0 msg=ok`;
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
    return response.json() as Promise<{ session: string }>;
  };
  return {
    request, exchange, queue, state, audit, bot, remote, app,
    get downloads() { return downloads; },
    get searchCalls() { return searchCalls; },
    setSearch: (fn: typeof searchImpl) => { searchImpl = fn; },
    setDumpFailure: (stderr: string) => {
      dumpOverride = async () => ({ code: 1, stdout: '', stderr });
    },
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

  it('rate-limits searches per identity and across the service', async () => using(async f => {
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

    const b = await f.exchange(otherBinding);
    const otherStarted = deferred<void>();
    const otherGate = deferred<void>();
    let servedOther = false;
    f.setSearch(async () => {
      if (!servedOther) {
        servedOther = true;
        otherStarted.resolve();
        await otherGate.promise;
        return [dumpRow({ id: 'ddddddddddd', title: 'Other', durationSec: 100 })];
      }
      return [dumpRow({ id: 'eeeeeeeeeee', title: 'Extra', durationSec: 100 })];
    });
    const pendingB = f.request('/search', { session: b.session, body: { query: 'slow-other' } });
    await otherStarted.promise;
    const cBinding = { ...binding, uid: 'third-listener', clid: 11 };
    const c = await f.exchange(cBinding);
    assert.equal((await f.request('/search', { session: c.session, body: { query: 'too-many' } })).status, 429);
    gate.resolve();
    otherGate.resolve();
    assert.equal((await pending).status, 200);
    assert.equal((await pendingB).status, 200);
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
    const failed = await f.request('/search', { session, body: { query: 'provider-down' } });
    assert.equal(failed.status, 503);
    const body = await failed.json() as { error: string; code: string };
    assert.deepEqual(body, { error: 'Listener remote is unavailable.', code: 'unavailable' });
    assert.ok(!JSON.stringify(body).includes('credential'));
    assert.ok(!JSON.stringify(body).includes('Sign in'));
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
});

