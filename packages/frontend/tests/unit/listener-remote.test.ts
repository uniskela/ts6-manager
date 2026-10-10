import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  captureRemoteLaunchToken,
  remoteLaunchToken,
  resetRemoteLaunchForTests,
  takeHashToken,
} from '../../src/lib/listener-remote-launch';
import {
  RemoteHttpError,
  clearRemoteSession,
  exchangeRemoteToken,
  loadRemoteLibrary,
  loadRemoteState,
  playbackSummary,
  queueRemoteSong,
  remoteMediaUrlError,
  remoteSession,
  requestRemoteUrl,
  resetRemoteClientForTests,
  shouldPollRemote,
} from '../../src/lib/listener-remote';

const token = 't'.repeat(43);
const session = 's'.repeat(43);
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
  const calls: Array<{ url: string; method: string; body: string | null; authorization: string | null }> = [];
  let persisted = false;

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
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
        authorization: headers.get('Authorization'),
      });
      const url = new URL(String(input), 'http://remote.test');
      if (url.pathname.endsWith('/exchange')) {
        const posted = JSON.parse(String(init?.body));
        assert.deepEqual(posted, { token });
        return json({ session, expiresAt: future, botId: 12 });
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
      if (url.pathname.endsWith('/queue') || url.pathname.endsWith('/requests')) return json({ ok: true });
      return json({ error: 'nope', code: 'invalid_request' }, 400);
    }) as typeof fetch;
  });

  afterEach(() => {
    resetRemoteClientForTests();
    clearRemoteSession();
  });

  it('exchanges a token once, keeps the session in memory, and fail-closes missing permissions', async () => {
    assert.deepEqual(await exchangeRemoteToken(token), { session, expiresAt: future, botId: 12 });
    assert.equal(calls.length, 1);
    await exchangeRemoteToken(token);
    assert.equal(calls.length, 1);
    assert.equal(remoteSession()?.session, session);
    assert.equal(persisted, false);
    const state = await loadRemoteState();
    assert.equal(state.nowPlaying?.title, 'Neon Skyline');
    assert.equal('filePath' in (state.nowPlaying ?? {}), false);
    assert.deepEqual(state.permissions, { searchLibrary: true, addToQueue: false, requestUrl: false });
    assert.equal(calls[1].authorization, `Bearer ${session}`);
    assert.equal(playbackSummary(state.nowPlaying, 'playing').label, 'Playing · 3:34');
    assert.equal(shouldPollRemote(false, 0, 10_000), false);
    assert.equal(shouldPollRemote(true, 0, 4_999), false);
    assert.equal(shouldPollRemote(true, 0, 5_000), true);
  });

  it('clears the session on 401 and does not retry a mutation automatically', async () => {
    await exchangeRemoteToken(token);
    globalThis.fetch = (async () => json({ error: 'Listener access is invalid or expired.', code: 'invalid_access' }, 401)) as typeof fetch;
    await assert.rejects(() => loadRemoteState(), (error: unknown) => error instanceof RemoteHttpError && error.status === 401);
    assert.equal(remoteSession(), null);
    await assert.rejects(() => queueRemoteSong(9), (error: unknown) => error instanceof RemoteHttpError && error.status === 401);
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
});
