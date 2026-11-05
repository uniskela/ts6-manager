import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOT_COOLDOWN_MS,
  FAILED_REQUESTER_COOLDOWN_MS,
  OPEN_RATE_LIMIT,
  OPEN_RATE_WINDOW_MS,
  PlaylistVoteMachine,
  approvalsNeeded,
  type PlaylistVoteSettings,
  type QueuePlaylistHook,
} from './state-machine.js';

const settings: PlaylistVoteSettings = {
  thresholdPercent: 80,
  windowMs: 60_000,
  maxTracks: 25,
};

const playlist = { id: 7, name: 'Live smoke', trackCount: 3 };

describe('approvalsNeeded', () => {
  it('matches the roadmap 80% table', () => {
    const cases: Array<[number, number]> = [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 4],
      [6, 5],
      [10, 8],
    ];
    for (const [listeners, needed] of cases) {
      assert.equal(approvalsNeeded(80, listeners), needed, `listeners=${listeners}`);
    }
  });
});

describe('PlaylistVoteMachine', () => {
  it('opens a vote with requester auto-yes and announce_open only', () => {
    const m = new PlaylistVoteMachine();
    const r = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2', 'u3'],
      nowMs: 1_000,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.created, true);
    assert.equal(r.vote.status, 'open');
    assert.equal(r.vote.yes, 1);
    assert.equal(r.vote.needed, 3);
    assert.equal(r.vote.deadline, new Date(61_000).toISOString());
    assert.deepEqual(
      r.events.map((e) => e.type),
      ['announce_open'],
    );
  });

  it('returns the same vote for the same requester and playlist without a new rate hit', () => {
    const m = new PlaylistVoteMachine({ botCooldownMs: 0, failedRequesterCooldownMs: 0 });
    const first = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 5_000,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.created, false);
    assert.equal(second.vote.id, first.vote.id);
    assert.equal(second.events.length, 0);
  });

  it('refuses a second concurrent request from another listener', () => {
    const m = new PlaylistVoteMachine();
    assert.equal(
      m.openVote({
        botKey: 'b1',
        channelId: 'c1',
        requesterUid: 'u1',
        playlist,
        settings,
        listenerUids: ['u1', 'u2'],
        nowMs: 0,
      }).ok,
      true,
    );
    const other = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u2',
      playlist: { ...playlist, id: 9 },
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 1,
    });
    assert.equal(other.ok, false);
    if (other.ok) return;
    assert.equal(other.code, 'vote_running');
  });

  it('queues immediately when the requester is the only listener', () => {
    const m = new PlaylistVoteMachine();
    const r = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1'],
      nowMs: 10,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.vote.status, 'passed');
    assert.deepEqual(
      r.events.map((e) => e.type),
      ['queue', 'announce_result'],
    );
  });

  it('passes as soon as approvals reach the live threshold', () => {
    const m = new PlaylistVoteMachine();
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const ballot = m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u2',
      choice: 'yes',
      listenerUids: ['u1', 'u2'],
      nowMs: 1_000,
    });
    assert.equal(ballot.ok, true);
    if (!ballot.ok) return;
    assert.equal(ballot.vote.status, 'passed');
    assert.equal(ballot.vote.reason, 'approved');
    assert.ok(ballot.events.some((e) => e.type === 'queue'));
    assert.ok(ballot.events.some((e) => e.type === 'announce_result'));
  });

  it('does not fail early when behind; fails at the deadline', () => {
    const m = new PlaylistVoteMachine();
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2', 'u3'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const no = m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u2',
      choice: 'no',
      listenerUids: ['u1', 'u2', 'u3'],
      nowMs: 10,
    });
    assert.equal(no.ok, true);
    if (!no.ok) return;
    assert.equal(no.vote.status, 'open');

    const early = m.tickDeadline({
      botKey: 'b1',
      channelId: 'c1',
      listenerUids: ['u1', 'u2', 'u3'],
      nowMs: 59_999,
    });
    assert.equal(early.length, 0);

    const late = m.tickDeadline({
      botKey: 'b1',
      channelId: 'c1',
      listenerUids: ['u1', 'u2', 'u3'],
      nowMs: 60_000,
    });
    assert.ok(late.some((e) => e.type === 'announce_result'));
    const view = m.viewForState('b1', 'c1', 'u1', ['u1', 'u2', 'u3'], 60_001);
    assert.equal(view?.status, 'failed');
    assert.equal(view?.reason, 'deadline');
  });

  it('emits at most two channel announces per vote', () => {
    const m = new PlaylistVoteMachine();
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.events.filter((e) => e.type.startsWith('announce')).length, 1);

    const done = m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u2',
      choice: 'yes',
      listenerUids: ['u1', 'u2'],
      nowMs: 1,
    });
    assert.equal(done.ok, true);
    if (!done.ok) return;
    const announces = [...opened.events, ...done.events].filter((e) => e.type.startsWith('announce'));
    assert.deepEqual(
      announces.map((e) => e.type),
      ['announce_open', 'announce_result'],
    );
  });

  it('cancels when the requester votes no', () => {
    const m = new PlaylistVoteMachine();
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const cancel = m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u1',
      choice: 'no',
      listenerUids: ['u1', 'u2'],
      nowMs: 5,
    });
    assert.equal(cancel.ok, true);
    if (!cancel.ok) return;
    assert.equal(cancel.vote.status, 'cancelled');
    assert.equal(cancel.vote.reason, 'requester_cancelled');
  });

  it('refuses requester ballot withdrawal', () => {
    const m = new PlaylistVoteMachine();
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const w = m.withdrawBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u1',
      listenerUids: ['u1', 'u2'],
      nowMs: 1,
    });
    assert.equal(w.ok, false);
    if (w.ok) return;
    assert.equal(w.code, 'invalid_request');
  });

  it('drops a leaver ballot and lets a joiner vote', () => {
    const m = new PlaylistVoteMachine();
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2', 'u3'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u2',
      choice: 'yes',
      listenerUids: ['u1', 'u2', 'u3'],
      nowMs: 1,
    });
    const afterLeave = m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u4',
      choice: 'yes',
      listenerUids: ['u1', 'u3', 'u4'],
      nowMs: 2,
    });
    assert.equal(afterLeave.ok, true);
    if (!afterLeave.ok) return;
    assert.equal(afterLeave.vote.yes, 2);
    assert.equal(afterLeave.vote.listeners, 3);
    assert.equal(afterLeave.vote.status, 'open');
  });

  it('cancels when the requester leaves', () => {
    const m = new PlaylistVoteMachine();
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u2',
      choice: 'yes',
      listenerUids: ['u2'],
      nowMs: 3,
    });
    const view = m.viewForState('b1', 'c1', 'u2', ['u2'], 4);
    assert.equal(view?.status, 'cancelled');
    assert.equal(view?.reason, 'requester_left');
  });

  it('drops open votes on restart without queueing', () => {
    let queues = 0;
    const queuePlaylist: QueuePlaylistHook = () => {
      queues += 1;
      return 'queued';
    };
    const m = new PlaylistVoteMachine({ queuePlaylist });
    m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    m.onRestart();
    assert.equal(m.getOpen('b1', 'c1'), undefined);
    assert.equal(m.viewForState('b1', 'c1', 'u1', ['u1', 'u2'], 1), null);
    assert.equal(queues, 0);
  });

  it('keeps a closed vote visible for 30s then clears it', () => {
    const m = new PlaylistVoteMachine({ closedVisibleMs: 30_000 });
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.ok(m.viewForState('b1', 'c1', 'u1', ['u1'], 10));
    assert.equal(m.viewForState('b1', 'c1', 'u1', ['u1'], 30_001), null);
  });

  it('refuses oversize and empty playlists', () => {
    const m = new PlaylistVoteMachine();
    const big = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist: { id: 1, name: 'huge', trackCount: 26 },
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    assert.equal(big.ok, false);
    if (big.ok) return;
    assert.equal(big.code, 'request_too_large');

    const empty = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist: { id: 2, name: 'empty', trackCount: 0 },
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    assert.equal(empty.ok, false);
    if (empty.ok) return;
    assert.equal(empty.code, 'playlist_empty');
  });

  it('fails silently at the deadline when no listeners remain', () => {
    const m = new PlaylistVoteMachine();
    assert.equal(
      m.openVote({
        botKey: 'b1',
        channelId: 'c1',
        requesterUid: 'u1',
        playlist,
        settings,
        listenerUids: ['u1', 'u2'],
        nowMs: 0,
      }).ok,
      true,
    );
    const events = m.tickDeadline({
      botKey: 'b1',
      channelId: 'c1',
      listenerUids: [],
      nowMs: 60_000,
    });
    assert.equal(events.length, 0);
    const view = m.viewForState('b1', 'c1', 'u1', [], 60_001);
    assert.equal(view?.status, 'failed');
    assert.equal(view?.reason, 'deadline');
  });

  it('calls the queue hook once and records queue_full without a queue event', () => {
    let calls = 0;
    const m = new PlaylistVoteMachine({
      queuePlaylist: () => {
        calls += 1;
        return 'queue_full';
      },
    });
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const done = m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u2',
      choice: 'yes',
      listenerUids: ['u1', 'u2'],
      nowMs: 1,
    });
    assert.equal(done.ok, true);
    if (!done.ok) return;
    assert.equal(done.vote.status, 'failed');
    assert.equal(done.vote.reason, 'queue_full');
    assert.equal(calls, 1);
    assert.equal(done.events.some((e) => e.type === 'queue'), false);
    assert.ok(done.events.some((e) => e.type === 'announce_result'));
  });

  it('enforces the 120s bot cooldown after any vote', () => {
    const m = new PlaylistVoteMachine();
    assert.equal(
      m.openVote({
        botKey: 'b1',
        channelId: 'c1',
        requesterUid: 'u1',
        playlist,
        settings,
        listenerUids: ['u1'],
        nowMs: 0,
      }).ok,
      true,
    );
    const blocked = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u2',
      playlist: { ...playlist, id: 8 },
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 1,
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.code, 'rate_limited');
      assert.equal(blocked.retryAfterMs, BOT_COOLDOWN_MS - 1);
    }
    assert.equal(
      m.openVote({
        botKey: 'b1',
        channelId: 'c1',
        requesterUid: 'u2',
        playlist: { ...playlist, id: 8 },
        settings,
        listenerUids: ['u1', 'u2'],
        nowMs: BOT_COOLDOWN_MS,
      }).ok,
      true,
    );
  });

  it('enforces the 5-minute cooldown for a requester whose vote failed', () => {
    const m = new PlaylistVoteMachine();
    assert.equal(
      m.openVote({
        botKey: 'b1',
        channelId: 'c1',
        requesterUid: 'u1',
        playlist,
        settings,
        listenerUids: ['u1', 'u2'],
        nowMs: 0,
      }).ok,
      true,
    );
    m.tickDeadline({
      botKey: 'b1',
      channelId: 'c1',
      listenerUids: ['u1', 'u2'],
      nowMs: 60_000,
    });

    const blocked = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist: { ...playlist, id: 9 },
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: 60_000 + BOT_COOLDOWN_MS,
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, 'rate_limited');

    assert.equal(
      m.openVote({
        botKey: 'b1',
        channelId: 'c1',
        requesterUid: 'u1',
        playlist: { ...playlist, id: 9 },
        settings,
        listenerUids: ['u1', 'u2'],
        nowMs: 60_000 + FAILED_REQUESTER_COOLDOWN_MS,
      }).ok,
      true,
    );
  });

  it('limits a requester to three opens per ten minutes', () => {
    const m = new PlaylistVoteMachine({
      botCooldownMs: 0,
      failedRequesterCooldownMs: 0,
    });
    for (let i = 0; i < OPEN_RATE_LIMIT; i++) {
      const opened = m.openVote({
        botKey: 'b1',
        channelId: 'c1',
        requesterUid: 'u1',
        playlist: { ...playlist, id: 100 + i },
        settings,
        listenerUids: ['u1', 'u2'],
        nowMs: i,
      });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      m.cancelByRequester({
        voteId: opened.vote.id,
        botKey: 'b1',
        channelId: 'c1',
        requesterUid: 'u1',
        listenerUids: ['u1', 'u2'],
        nowMs: i,
      });
    }
    const blocked = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist: { ...playlist, id: 999 },
      settings,
      listenerUids: ['u1', 'u2'],
      nowMs: OPEN_RATE_LIMIT,
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, 'rate_limited');

    assert.equal(
      m.openVote({
        botKey: 'b1',
        channelId: 'c1',
        requesterUid: 'u1',
        playlist: { ...playlist, id: 1000 },
        settings,
        listenerUids: ['u1', 'u2'],
        nowMs: OPEN_RATE_WINDOW_MS,
      }).ok,
      true,
    );
  });

  it('rejects ballots after the deadline and closes as deadline failure', () => {
    const m = new PlaylistVoteMachine();
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2', 'u3'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const lateYes = m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u2',
      choice: 'yes',
      listenerUids: ['u1', 'u2', 'u3'],
      nowMs: 60_000,
    });
    assert.equal(lateYes.ok, false);
    if (!lateYes.ok) assert.equal(lateYes.code, 'not_found');

    const view = m.viewForState('b1', 'c1', 'u1', ['u1', 'u2', 'u3'], 60_001);
    assert.equal(view?.status, 'failed');
    assert.equal(view?.reason, 'deadline');
  });

  it('freezes closed vote tallies against the closing electorate', () => {
    const m = new PlaylistVoteMachine({ closedVisibleMs: 30_000 });
    const opened = m.openVote({
      botKey: 'b1',
      channelId: 'c1',
      requesterUid: 'u1',
      playlist,
      settings,
      listenerUids: ['u1', 'u2', 'u3', 'u4', 'u5'],
      nowMs: 0,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u2',
      choice: 'yes',
      listenerUids: ['u1', 'u2', 'u3', 'u4', 'u5'],
      nowMs: 10,
    });
    m.castBallot({
      voteId: opened.vote.id,
      botKey: 'b1',
      channelId: 'c1',
      voterUid: 'u3',
      choice: 'yes',
      listenerUids: ['u1', 'u2', 'u3', 'u4', 'u5'],
      nowMs: 20,
    });
    // 3 yes of 5 listeners → needed 4 at 80%; still open, then deadline fails.
    m.tickDeadline({
      botKey: 'b1',
      channelId: 'c1',
      listenerUids: ['u1', 'u2', 'u3', 'u4', 'u5'],
      nowMs: 60_000,
    });

    const afterLeavers = m.viewForState('b1', 'c1', 'u1', ['u1', 'u2', 'u3'], 60_500);
    assert.equal(afterLeavers?.status, 'failed');
    assert.equal(afterLeavers?.reason, 'deadline');
    assert.equal(afterLeavers?.listeners, 5);
    assert.equal(afterLeavers?.needed, 4);
    assert.equal(afterLeavers?.yes, 3);
  });
});
