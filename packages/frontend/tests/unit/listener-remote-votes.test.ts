import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  RemoteHttpError,
  canRequestRemotePlaylist,
  canVoteRemote,
  cancelRemoteVote,
  castRemoteBallot,
  exchangeRemoteToken,
  loadRemoteState,
  parseRemoteVote,
  remotePlaylistRequestErrorMessage,
  remoteVoteErrorMessage,
  requestRemotePlaylist,
  resetRemoteClientForTests,
  retryAfterText,
  voteCountsText,
  voteResultMessage,
  voteSecondsLeft,
  withdrawRemoteBallot,
  type RemoteVote,
} from '../../src/lib/listener-remote';

const token = 't'.repeat(43);
const session = 's'.repeat(43);
const voteId = 'v'.repeat(22);
const future = new Date(Date.now() + 60_000).toISOString();

const vote: RemoteVote = {
  id: voteId,
  status: 'open',
  reason: null,
  playlist: { id: 3, name: 'Chill', trackCount: 12 },
  yes: 2,
  no: 1,
  needed: 4,
  listeners: 5,
  thresholdPercent: 80,
  deadline: future,
  ownBallot: null,
  isRequester: false,
};

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
const calls: Array<{ path: string; method: string; body: string | null }> = [];
let reply: (path: string, method: string) => Reply;

function respond({ status = 200, body, headers = {} }: Reply): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

beforeEach(async () => {
  resetRemoteClientForTests();
  calls.length = 0;
  reply = () => ({ body: { ok: true } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://remote.test');
    const path = url.pathname.replace('/api/listener-remote', '');
    if (path === '/exchange') return respond({ body: { session, expiresAt: future, botId: 12 } });
    calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
    return respond(reply(path, init?.method ?? 'GET'));
  }) as typeof fetch;
  await exchangeRemoteToken(token);
});

describe('listener remote votes: parsing', () => {
  it('keeps only the allow-listed vote fields', () => {
    const parsed = parseRemoteVote({
      ...vote,
      voters: ['alice'],
      requesterUid: 'secret-uid',
      playlist: { ...vote.playlist, filePath: '/music/x.mp3' },
    });
    assert.deepEqual(parsed, vote);
    assert.equal(JSON.stringify(parsed).includes('alice'), false);
    assert.equal(JSON.stringify(parsed).includes('secret-uid'), false);
  });

  it('rejects malformed votes', () => {
    for (const bad of [
      { ...vote, id: 'short' },
      { ...vote, id: '../../admin/x/abcdefghi' },
      { ...vote, status: 'maybe' },
      { ...vote, reason: 'because' },
      { ...vote, yes: -1 },
      { ...vote, needed: 1.5 },
      { ...vote, deadline: 'soon' },
      { ...vote, ownBallot: 'abstain' },
      { ...vote, playlist: { id: 0, name: 'x', trackCount: 1 } },
    ]) {
      assert.throws(() => parseRemoteVote(bad), RemoteHttpError);
    }
    assert.equal(parseRemoteVote({ ...vote, playlist: { id: null, name: 'Hidden now', trackCount: 2 } }).playlist.id, null);
  });

  it('reads the B3 state fields, and a bad vote hides the banner instead of the remote', async () => {
    const base = {
      bot: { id: 12, name: 'Aurora', status: 'playing' },
      nowPlaying: null,
      upNext: [],
      upNextCount: 0,
      permissions: { searchLibrary: true, addToQueue: true, requestUrl: true, requestPlaylist: true, vote: true },
      playlistRequests: { voting: true, thresholdPercent: 80, windowSeconds: 60, maxTracks: 25 },
      limits: { maxRequestSeconds: 900 },
      vote,
    };
    reply = () => ({ body: base });
    const state = await loadRemoteState();
    assert.deepEqual(state.vote, vote);
    assert.deepEqual(state.playlistRequests, { voting: true, thresholdPercent: 80, windowSeconds: 60, maxTracks: 25 });
    assert.equal(canRequestRemotePlaylist(state.permissions), true);
    assert.equal(canVoteRemote(state.permissions), true);

    reply = () => ({ body: { ...base, vote: { ...vote, status: 'weird' }, playlistRequests: { voting: 'yes' } } });
    const tolerant = await loadRemoteState();
    assert.equal(tolerant.vote, null);
    assert.equal(tolerant.playlistRequests, null);

    // Older backends: no flags means no playlist requests and no ballots.
    reply = () => ({ body: { ...base, permissions: { searchLibrary: true }, playlistRequests: undefined, vote: undefined } });
    const old = await loadRemoteState();
    assert.equal(canRequestRemotePlaylist(old.permissions), false);
    assert.equal(canVoteRemote(old.permissions), false);
    assert.equal(old.vote, null);
  });
});

describe('listener remote votes: requests', () => {
  it('requests a playlist and reads both outcomes', async () => {
    reply = () => ({ body: { ok: true, outcome: 'queued', trackCount: 7 } });
    assert.deepEqual(await requestRemotePlaylist(3), { outcome: 'queued', trackCount: 7 });
    reply = () => ({ body: { ok: true, outcome: 'vote', created: true, vote } });
    assert.deepEqual(await requestRemotePlaylist(3), { outcome: 'vote', created: true, vote });
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
      ['POST', '/playlist-requests', '{"playlistId":3}'],
      ['POST', '/playlist-requests', '{"playlistId":3}'],
    ]);
    await assert.rejects(() => requestRemotePlaylist(0), RemoteHttpError);
    assert.equal(calls.length, 2);
  });

  it('casts, withdraws and cancels on the vote path, and never sends a bad id', async () => {
    reply = () => ({ body: { ok: true, vote: { ...vote, ownBallot: 'yes', yes: 3 } } });
    assert.equal((await castRemoteBallot(voteId, 'yes')).ownBallot, 'yes');
    reply = () => ({ body: { ok: true, vote } });
    assert.equal((await withdrawRemoteBallot(voteId)).ownBallot, null);
    reply = () => ({ body: { ok: true } });
    await cancelRemoteVote(voteId);
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
      ['PUT', `/votes/${voteId}/ballot`, '{"choice":"yes"}'],
      ['DELETE', `/votes/${voteId}/ballot`, null],
      ['DELETE', `/votes/${voteId}`, null],
    ]);
    for (const bad of ['../state', `${voteId}/x`, 'short']) {
      await assert.rejects(() => castRemoteBallot(bad, 'yes'), RemoteHttpError);
      await assert.rejects(() => withdrawRemoteBallot(bad), RemoteHttpError);
      await assert.rejects(() => cancelRemoteVote(bad), RemoteHttpError);
    }
    await assert.rejects(() => castRemoteBallot(voteId, 'maybe' as 'yes'), RemoteHttpError);
    assert.equal(calls.length, 3);
  });

  it('carries Retry-After into plain wait times', async () => {
    reply = () => ({
      status: 429,
      body: { error: 'Too many remote requests', code: 'rate_limited' },
      headers: { 'Retry-After': '120' },
    });
    const error = await requestRemotePlaylist(3).catch((e: unknown) => e);
    assert.ok(error instanceof RemoteHttpError);
    assert.equal(error.retryAfterSeconds, 120);
    assert.equal(remotePlaylistRequestErrorMessage(error), 'Playlist requests are paused right now. Try again in about 2 minutes.');
    assert.equal(retryAfterText(1), '1 second');
    assert.equal(retryAfterText(45), '45 seconds');
    assert.equal(retryAfterText(null), null);
    assert.equal(
      remotePlaylistRequestErrorMessage(new RemoteHttpError(429, 'rate_limited', 'x')),
      'Playlist requests are paused right now. Try again in a few minutes.',
    );
  });
});

describe('listener remote votes: wording', () => {
  it('explains each refusal without technical terms', () => {
    const message = (code: string, status = 409, text = 'server text') =>
      remotePlaylistRequestErrorMessage(new RemoteHttpError(status, code, text));
    assert.match(message('vote_running'), /Another playlist vote is running/);
    assert.match(message('playlist_not_requestable'), /not requested as a whole/);
    assert.match(message('playlist_empty', 422), /no songs/);
    assert.match(message('queue_full'), /queue is full/);
    assert.match(message('not_found', 404), /no longer shared/);
    // The server's text names the configured limit.
    assert.equal(message('request_too_large', 422, 'Playlist requests are limited to 25 tracks.'), 'Playlist requests are limited to 25 tracks.');

    const ballot = (code: string, status: number) => remoteVoteErrorMessage(new RemoteHttpError(status, code, 'server text'));
    assert.equal(ballot('not_found', 404), 'This vote has already ended.');
    assert.equal(ballot('permission_denied', 403), 'You are not allowed to vote on playlists right now.');
    assert.match(remoteVoteErrorMessage(new RemoteHttpError(403, 'permission_denied', 'x'), 'cancel'), /Only the person who proposed/);
    assert.match(message('unavailable', 503), /could not be confirmed\. Check Up next/);
    assert.match(ballot('rate_limited', 429), /voting too quickly/);
    assert.match(ballot('unavailable', 503), /could not check who is in the channel/);
  });

  it('describes every way a vote can end', () => {
    const ended = (reason: RemoteVote['reason'], status: RemoteVote['status'], isRequester = false) =>
      voteResultMessage({ ...vote, status, reason, isRequester });
    assert.equal(ended('approved', 'passed'), 'Vote passed. 12 songs from “Chill” were added to the queue.');
    assert.match(ended('deadline', 'failed'), /Not enough listeners voted yes/);
    assert.equal(ended('requester_cancelled', 'cancelled', true), 'You cancelled the vote.');
    assert.match(ended('requester_cancelled', 'cancelled'), /cancelled by the person who proposed it/);
    assert.match(ended('requester_left', 'cancelled'), /left the channel/);
    assert.match(ended('bot_unavailable', 'cancelled'), /bot stopped or moved/);
    assert.match(ended('revoked', 'cancelled'), /remote access ended/);
    assert.match(ended('playlist_unavailable', 'cancelled'), /no longer shared/);
    assert.match(ended('queue_full', 'failed'), /queue is full/);
    assert.match(ended('listeners_unavailable', 'failed'), /could not check who is in the channel/);
    assert.equal(voteCountsText(vote), '2 yes · 1 no · needs 4 of 5 listeners');
    assert.equal(voteCountsText({ ...vote, listeners: 1, needed: 1, yes: 1, no: 0 }), '1 yes · 0 no · needs 1 of 1 listener');
  });

  it('clamps the countdown to the vote window', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const at = (seconds: number) => ({ ...vote, deadline: new Date(now + seconds * 1000).toISOString() });
    assert.equal(voteSecondsLeft(at(42.2), now), 43);
    assert.equal(voteSecondsLeft(at(-5), now), 0);
    // A phone clock that runs slow must not show more than the window.
    assert.equal(voteSecondsLeft(at(600), now), 60);
    assert.equal(voteSecondsLeft(at(600), now, 90), 90);
  });
});
