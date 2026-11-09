import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  captureRemoteLaunchToken,
  installRemoteTokenCapture,
  remoteLaunchToken,
  resetRemoteLaunchForTests,
  takeHashToken,
} from '../../src/lib/listener-remote-launch';
import {
  RemoteHttpError,
  canBrowseRemotePlaylists,
  canSearchRemoteMusic,
  clearRemoteSession,
  exchangeRemoteToken,
  formatRemoteExpiry,
  loadRemoteLibrary,
  loadRemotePlaylistSongs,
  loadRemotePlaylists,
  loadRemoteState,
  parseRemotePlaylist,
  parseRemotePlaylistPage,
  parseRemotePlaylistSongsPage,
  parseRemoteSearchResponse,
  playbackSummary,
  queueRemoteSearchResult,
  queueRemoteSong,
  remoteMediaUrlError,
  remoteSearchErrorMessage,
  remoteSearchQueryError,
  remoteSearchQueueErrorMessage,
  remoteSession,
  requestRemoteUrl,
  resetRemoteClientForTests,
  searchQueueFailure,
  searchRemoteMusic,
  settleRemoteExchange,
  shouldPollRemote,
} from '../../src/lib/listener-remote';

const token = 't'.repeat(43);
const future = new Date(Date.now() + 60_000).toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('listener remote launch token', () => {
  beforeEach(() => resetRemoteLaunchForTests());

  it('reads a fragment token and drops it from the hash', () => {
    const urls: string[] = [];
    const got = captureRemoteLaunchToken(
      { pathname: '/remote', search: '', hash: `#token=${token}&stay=1` },
      (url) => urls.push(url),
    );
    assert.equal(got, token);
    assert.deepEqual(urls, ['/remote#stay=1']);
    assert.equal(remoteLaunchToken(), token);
    assert.equal(captureRemoteLaunchToken(
      { pathname: '/remote', search: '', hash: '#token=again' },
      (url) => urls.push(url),
    ), token);
    assert.equal(urls.length, 1);
  });

  it('strips an invalid token without posting it later', () => {
    const urls: string[] = [];
    assert.equal(captureRemoteLaunchToken(
      { pathname: '/remote', search: '?x=1', hash: '#token=short' },
      (url) => urls.push(url),
    ), null);
    assert.deepEqual(urls, ['/remote?x=1']);
  });

  it('leaves other pages and query strings alone', () => {
    const taken = takeHashToken('not-a-hash');
    assert.equal(taken.removed, false);
    const urls: string[] = [];
    captureRemoteLaunchToken(
      { pathname: '/dashboard', search: '', hash: `#token=${token}` },
      (url) => urls.push(url),
    );
    assert.deepEqual(urls, []);
    assert.equal(remoteLaunchToken(), null);
  });
});

describe('listener remote client', () => {
  const calls: Array<{
    url: string; method: string; body: string | null;
    authorization: string | null; csrf: string | null; credentials: RequestCredentials | undefined;
  }> = [];
  let persisted = false;
  const csrf = 'c'.repeat(43);

  beforeEach(() => {
    resetRemoteClientForTests();
    calls.length = 0;
    persisted = false;
    const storage = {
      getItem: () => null,
      setItem: () => { persisted = true; },
      removeItem: () => { persisted = true; },
      clear: () => { persisted = true; },
      key: () => null,
      length: 0,
    };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { cookie: `ts6_lr_csrf=${csrf}` },
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
        authorization: headers.get('Authorization'),
        csrf: headers.get('X-CSRF-Token'),
        credentials: init?.credentials,
      });
      const url = new URL(String(input), 'http://remote.test');
      if (url.pathname.endsWith('/exchange')) {
        const posted = JSON.parse(String(init?.body));
        assert.equal(posted.token, token);
        assert.equal(posted.remember, false);
        return json({ expiresAt: future, botId: 12, csrfToken: csrf, remember: false });
      }
      if (url.pathname.endsWith('/state')) {
        return json({
          bot: { id: 12, name: 'Aurora', status: 'playing' },
          nowPlaying: { id: '1', title: 'Neon Skyline', artist: 'Midnight Transit', duration: 214, filePath: '/secret.mp3' },
          upNext: [],
          upNextCount: 0,
          permissions: { searchLibrary: true },
        });
      }
      if (url.pathname.endsWith('/library')) {
        assert.equal(url.searchParams.get('search'), 'paper');
        assert.equal(url.searchParams.get('page'), '2');
        return json({ songs: [{ id: 9, title: 'Paper Moon', artist: null, duration: null }], page: 2, pageSize: 25 });
      }
      if (url.pathname.endsWith('/search')) {
        return json({
          results: [{
            id: 'r'.repeat(22),
            title: 'Neon Skyline',
            artist: 'Midnight Transit',
            duration: 214,
            url: 'https://secret.example/track',
          }],
          expiresAt: future,
        });
      }
      if (url.pathname.endsWith('/playlists')) {
        assert.equal(url.searchParams.get('search'), 'chill');
        assert.equal(url.searchParams.get('page'), '1');
        return json({
          playlists: [{
            id: 3,
            name: 'Chill',
            trackCount: 2,
            duration: 400,
            wholeRequest: true,
            serverConfigId: 99,
            filePath: '/secret',
          }],
          page: 1,
          pageSize: 25,
        });
      }
      if (/\/playlists\/\d+\/songs$/.test(url.pathname)) {
        assert.equal(url.searchParams.get('page'), '2');
        return json({
          playlist: { id: 3, name: 'Chill', trackCount: 2, duration: 400, wholeRequest: false },
          songs: [{ id: 9, title: 'Paper Moon', artist: null, duration: null, filePath: '/secret.mp3' }],
          page: 2,
          pageSize: 25,
        });
      }
      if (url.pathname.endsWith('/search/queue') || url.pathname.endsWith('/queue') || url.pathname.endsWith('/requests')) return json({ ok: true });
      return json({ error: 'nope', code: 'invalid_request' }, 400);
    }) as typeof fetch;
  });

  afterEach(() => {
    resetRemoteClientForTests();
    clearRemoteSession();
  });

  it('exchanges a token once, keeps metadata in memory (not the cookie secret), and fail-closes missing permissions', async () => {
    assert.deepEqual(await exchangeRemoteToken(token), {
      expiresAt: future, botId: 12, csrfToken: csrf, remember: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.credentials, 'include');
    assert.equal(calls[0]!.authorization, null);
    await exchangeRemoteToken(token);
    assert.equal(calls.length, 1);
    assert.equal(remoteSession()?.botId, 12);
    assert.equal(persisted, false);
    const state = await loadRemoteState();
    assert.equal(state.nowPlaying?.title, 'Neon Skyline');
    assert.equal('filePath' in (state.nowPlaying ?? {}), false);
    assert.deepEqual(state.permissions, {
      searchLibrary: true,
      addToQueue: false,
      requestUrl: false,
      searchMusic: false,
    });
    assert.equal('browsePlaylists' in state.permissions, false);
    assert.equal(canBrowseRemotePlaylists(state.permissions), true);
    assert.equal(canBrowseRemotePlaylists({ searchLibrary: true, addToQueue: false, requestUrl: false, searchMusic: false, browsePlaylists: false }), false);
    assert.equal(canBrowseRemotePlaylists({ searchLibrary: false, addToQueue: false, requestUrl: false, searchMusic: false, browsePlaylists: true }), true);
    assert.equal(calls[1]!.authorization, null);
    assert.equal(calls[1]!.credentials, 'include');
    assert.equal(calls[1]!.csrf, null);
    await queueRemoteSong(9);
    assert.equal(calls.at(-1)!.csrf, csrf);
    assert.equal(calls.at(-1)!.authorization, null);
    assert.equal(calls.at(-1)!.credentials, 'include');
    assert.equal(formatRemoteExpiry(new Date(Date.now() + 90 * 60_000).toISOString(), Date.now()), 'Expires in 1h 30m');
    assert.equal(playbackSummary(state.nowPlaying, 'playing').label, 'Playing · 3:34');
    assert.equal(shouldPollRemote(false, 0, 10_000), false);
    assert.equal(shouldPollRemote(true, 0, 4_999), false);
    assert.equal(shouldPollRemote(true, 0, 5_000), true);
  });

  it('loads playlists and playlist songs with allow-listed fields only', async () => {
    await exchangeRemoteToken(token);
    const page = await loadRemotePlaylists('chill', 1);
    assert.deepEqual(page.playlists[0], {
      id: 3,
      name: 'Chill',
      trackCount: 2,
      duration: 400,
      wholeRequest: true,
    });
    assert.equal('serverConfigId' in page.playlists[0], false);
    assert.equal('filePath' in page.playlists[0], false);
    const songs = await loadRemotePlaylistSongs(3, 2);
    assert.equal(songs.playlist.name, 'Chill');
    assert.equal(songs.songs[0].id, 9);
    assert.equal('filePath' in songs.songs[0], false);
    await assert.rejects(() => loadRemotePlaylistSongs(0, 1), (error: unknown) => error instanceof RemoteHttpError && error.status === 400);
  });

  it('parses playlist payloads and rejects malformed rows', () => {
    const playlist = parseRemotePlaylist({
      id: 7,
      name: 'Drive',
      trackCount: 1,
      duration: null,
      wholeRequest: false,
      mode: 'stream',
    });
    assert.deepEqual(playlist, { id: 7, name: 'Drive', trackCount: 1, duration: null, wholeRequest: false });
    assert.equal('mode' in playlist, false);
    assert.throws(() => parseRemotePlaylist({ id: 7, name: 'Drive', trackCount: 1, duration: null }));
    assert.throws(() => parseRemotePlaylistPage({ playlists: 'nope', page: 1 }));
    assert.throws(() => parseRemotePlaylistSongsPage({
      playlist: { id: 7, name: 'Drive', trackCount: 1, duration: null, wholeRequest: false },
      songs: [{ id: 'bad', title: 'x' }],
      page: 1,
    }));
  });

  it('clears the session on 401 and does not retry a mutation automatically', async () => {
    await exchangeRemoteToken(token);
    globalThis.fetch = (async () => json({ error: 'Listener access is invalid or expired.', code: 'invalid_access' }, 401)) as typeof fetch;
    await assert.rejects(() => loadRemoteState(), (error: unknown) => error instanceof RemoteHttpError && error.status === 401);
    assert.equal(remoteSession(), null);
    await assert.rejects(() => queueRemoteSong(9), (error: unknown) => error instanceof RemoteHttpError && error.status === 401);
  });

  it('reports a full queue as 409 queue_full and keeps the session', async () => {
    await exchangeRemoteToken(token);
    globalThis.fetch = (async () => json({ error: 'The queue is full.', code: 'queue_full' }, 409)) as typeof fetch;
    await assert.rejects(() => queueRemoteSong(9), (error: unknown) => error instanceof RemoteHttpError
      && error.status === 409 && error.code === 'queue_full' && error.message === 'The queue is full.');
    assert.equal(remoteSession()?.botId, 12);
  });

  it('rejects pasted URLs that the contract will not accept', async () => {
    await exchangeRemoteToken(token);
    assert.equal(remoteMediaUrlError('https://user:pass@example.com/a'), 'This media URL is not allowed.');
    assert.equal(remoteMediaUrlError('ftp://example.com/a'), 'Paste an http or https URL.');
    await assert.rejects(() => requestRemoteUrl('https://user:pass@example.com/a'));
    assert.equal(calls.length, 1);
    calls.length = 0;
    await requestRemoteUrl('  https://example.com/a.mp3  ');
    assert.equal(calls[0].body, JSON.stringify({ url: 'https://example.com/a.mp3' }));
    const songs = await loadRemoteLibrary('paper', 2);
    assert.equal(songs.songs[0].id, 9);
  });

  it('keeps a live session when a later exchange is rejected', async () => {
    await exchangeRemoteToken(token);
    const other = 'u'.repeat(43);
    let posts = 0;
    globalThis.fetch = (async () => {
      posts += 1;
      return json({ error: 'Listener access is invalid or expired.', code: 'invalid_access' }, 401);
    }) as typeof fetch;
    await assert.rejects(() => exchangeRemoteToken(other), (error: unknown) => error instanceof RemoteHttpError && error.status === 401);
    await assert.rejects(() => exchangeRemoteToken(other));
    assert.equal(posts, 1);
    assert.equal(remoteSession()?.botId, 12);
  });

  it('retries a transient exchange instead of replaying the rejection', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) return json({ error: 'Listener remote is unavailable.', code: 'unavailable' }, 503);
      return json({ expiresAt: future, botId: 12, csrfToken: csrf, remember: false });
    }) as typeof fetch;
    await assert.rejects(() => exchangeRemoteToken(token));
    assert.equal(remoteSession(), null);
    assert.deepEqual(await exchangeRemoteToken(token), {
      expiresAt: future, botId: 12, csrfToken: csrf, remember: false,
    });
    assert.equal(attempts, 2);
  });

  it('does not let an older exchange replace a newer session', async () => {
    const first = 'a'.repeat(43);
    const second = 'b'.repeat(43);
    const waiting: Array<{ token: string; release(response: Response): void }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const posted = JSON.parse(String(init?.body)) as { token: string };
      return new Promise<Response>((resolve) => waiting.push({ token: posted.token, release: resolve }));
    }) as typeof fetch;
    const older = exchangeRemoteToken(first);
    const newer = exchangeRemoteToken(second);
    assert.equal(waiting.length, 2);
    const newerRequest = waiting.find((item) => item.token === second);
    const olderRequest = waiting.find((item) => item.token === first);
    assert.ok(newerRequest);
    assert.ok(olderRequest);
    newerRequest.release(json({ expiresAt: future, botId: 2, csrfToken: csrf, remember: false }));
    assert.equal((await newer).botId, 2);
    olderRequest.release(json({ expiresAt: future, botId: 1, csrfToken: csrf, remember: false }));
    await older;
    assert.equal(remoteSession()?.botId, 2);
  });

  it('keeps a live remote when a later exchange fails or repeats the same session', () => {
    const ready = { kind: 'ready' as const, nonce: 3 };
    const opening = { kind: 'opening' as const };
    const key = `12:${future}`;
    assert.deepEqual(settleRemoteExchange(opening, key, key, 'Remote access is invalid or expired'), { kind: 'ready', nonce: 0 });
    assert.equal(settleRemoteExchange(ready, key, key, 'Remote access is invalid or expired'), ready);
    assert.deepEqual(settleRemoteExchange(opening, null, null, 'Listener remote is unavailable.'), { kind: 'ended', message: 'Listener remote is unavailable.' });
    assert.equal(settleRemoteExchange(ready, key, key, null), ready);
    assert.deepEqual(settleRemoteExchange(ready, key, '2:' + future, null), { kind: 'ready', nonce: 4 });
    assert.deepEqual(settleRemoteExchange(opening, null, key, null), { kind: 'ready', nonce: 1 });
    assert.deepEqual(settleRemoteExchange(opening, null, null, null), { kind: 'ended', message: 'Remote access is invalid or expired' });
  });

  it('validates search queries and strips source URLs from search results', async () => {
    assert.equal(remoteSearchQueryError('a'), 'Enter at least 2 characters.');
    assert.equal(remoteSearchQueryError('x'.repeat(101)), 'Search queries can be at most 100 characters.');
    assert.equal(remoteSearchQueryError('https://example.com/song'), 'Paste a song name, not a link.');
    assert.equal(remoteSearchQueryError('HTTP://evil.test/x'), 'Paste a song name, not a link.');
    assert.equal(remoteSearchQueryError('  neon skyline  '), null);

    await exchangeRemoteToken(token);
    await assert.rejects(() => searchRemoteMusic('https://example.com/a'));
    assert.equal(calls.length, 1);
    calls.length = 0;

    const found = await searchRemoteMusic('  neon skyline  ');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body, JSON.stringify({ query: 'neon skyline' }));
    assert.deepEqual(found, {
      results: [{ id: 'r'.repeat(22), title: 'Neon Skyline', artist: 'Midnight Transit', duration: 214 }],
      expiresAt: future,
    });
    assert.equal('url' in found.results[0], false);

    await queueRemoteSearchResult('r'.repeat(22));
    assert.equal(calls[1].body, JSON.stringify({ resultId: 'r'.repeat(22) }));
    await assert.rejects(() => queueRemoteSearchResult('short'));
  });

  it('maps duration refusals and keeps queue_full messaging', () => {
    assert.equal(
      remoteSearchQueueErrorMessage(new RemoteHttpError(422, 'too_long', 'ignored')),
      'This track is longer than 15 minutes.',
    );
    assert.equal(
      remoteSearchQueueErrorMessage(new RemoteHttpError(422, 'live_not_allowed', 'ignored')),
      'Live streams are not allowed.',
    );
    assert.equal(
      remoteSearchQueueErrorMessage(new RemoteHttpError(422, 'duration_unknown', 'ignored')),
      'Track duration could not be verified.',
    );
    assert.equal(
      remoteSearchQueueErrorMessage(new RemoteHttpError(409, 'queue_full', 'The queue is full.')),
      'The queue is full.',
    );
    assert.deepEqual(
      parseRemoteSearchResponse({
        results: [{ id: 'a'.repeat(22), title: 'A', artist: null, duration: 90, sourceUrl: 'https://x' }],
        expiresAt: future,
      }),
      { results: [{ id: 'a'.repeat(22), title: 'A', artist: null, duration: 90 }], expiresAt: future },
    );
    assert.throws(() => parseRemoteSearchResponse({ results: [{ id: 'bad', title: 'A', artist: null, duration: 1 }], expiresAt: future }));
  });

  it('shows search only when the listener can also queue the result', () => {
    const base = { searchLibrary: true, requestUrl: false };
    assert.equal(canSearchRemoteMusic({ ...base, addToQueue: true, searchMusic: true }), true);
    // `/search` checks `add`; a read-only listener would only ever get 403.
    assert.equal(canSearchRemoteMusic({ ...base, addToQueue: false, searchMusic: true }), false);
    assert.equal(canSearchRemoteMusic({ ...base, addToQueue: true, searchMusic: false }), false);
  });

  it('drops spent search results after a failed queue attempt', () => {
    const tooLong = searchQueueFailure(new RemoteHttpError(422, 'too_long', 'ignored'));
    assert.deepEqual(tooLong, { message: 'This track is longer than 15 minutes.', drop: 'row' });

    const full = searchQueueFailure(new RemoteHttpError(409, 'queue_full', 'The queue is full.'));
    assert.deepEqual(full, { message: 'The queue is full. Search again to try this song.', drop: 'row' });

    const limited = searchQueueFailure(new RemoteHttpError(429, 'rate_limited', 'Too many remote requests'));
    assert.equal(limited.drop, 'row');
    assert.match(limited.message, /^Too many requests right now\. Wait a minute, then try again\. Search again/);

    const gone = searchQueueFailure(new RemoteHttpError(404, 'not_found', 'Search result not found.'));
    assert.deepEqual(gone, { message: 'These search results have run out. Search again.', drop: 'all' });

    const denied = searchQueueFailure(new RemoteHttpError(403, 'permission_denied', 'You are not allowed to use this command.'));
    assert.deepEqual(denied, { message: 'You are not allowed to use this command.', drop: 'row' });

    // Refused in the browser before the claim: the result is still valid.
    assert.equal(searchQueueFailure(new RemoteHttpError(400, 'invalid_request', 'Invalid listener request.')).drop, 'none');
    // A network failure may or may not have reached the claim; treat it as spent.
    assert.equal(searchQueueFailure(new Error('offline')).drop, 'row');

    assert.equal(
      remoteSearchErrorMessage(new RemoteHttpError(429, 'rate_limited', 'Too many remote requests')),
      'Too many searches right now. Wait a minute, then try again.',
    );
    assert.equal(remoteSearchErrorMessage(new RemoteHttpError(503, 'unavailable', 'Listener remote is unavailable.')), 'Listener remote is unavailable.');
  });
});

describe('listener remote token capture install', () => {
  const realWindow = (globalThis as any).window;
  const realEvent = (globalThis as any).Event;
  let listeners: Map<string, Set<() => void>>;

  beforeEach(() => {
    resetRemoteLaunchForTests();
    listeners = new Map();
    (globalThis as any).window = {
      location: { pathname: '/other', search: '', hash: '' },
      history: { replaceState() {} },
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
      dispatchEvent: () => true,
    };
    (globalThis as any).Event = class { constructor(public type: string) {} };
  });
  afterEach(() => {
    resetRemoteLaunchForTests();
    (globalThis as any).window = realWindow;
    (globalThis as any).Event = realEvent;
  });

  const count = () => listeners.get('hashchange')?.size ?? 0;

  it('installs one hashchange listener however many times it is called', () => {
    installRemoteTokenCapture();
    installRemoteTokenCapture();
    assert.equal(count(), 1);
  });

  it('returns a disposer that removes the listener and allows a fresh install', () => {
    const dispose = installRemoteTokenCapture();
    dispose();
    assert.equal(count(), 0);
    installRemoteTokenCapture();
    assert.equal(count(), 1);
  });

  it('does not stack listeners when the test reset runs between installs', () => {
    installRemoteTokenCapture();
    resetRemoteLaunchForTests();
    installRemoteTokenCapture();
    assert.equal(count(), 1);
  });
});
