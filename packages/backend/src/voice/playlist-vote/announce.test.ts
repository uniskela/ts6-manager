import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deliverPlaylistVoteAnnouncements,
  formatPlaylistVoteAnnounce,
  resetPlaylistVoteAnnounceDedupeForTests,
  sanitizePlaylistAnnounceName,
} from './announce.js';
import type { PlaylistVoteEvent, PlaylistVotePublic } from './state-machine.js';

function vote(partial: Partial<PlaylistVotePublic> = {}): PlaylistVotePublic {
  return {
    id: 'AAAAAAAAAAAAAAAAAAAAAA',
    status: 'open',
    reason: null,
    playlist: { id: 1, name: 'Chill', trackCount: 3 },
    yes: 1,
    no: 0,
    needed: 2,
    listeners: 3,
    thresholdPercent: 50,
    deadline: new Date(1_700_000_060_000).toISOString(),
    ownBallot: null,
    isRequester: false,
    ...partial,
  };
}

describe('playlist vote channel announces', () => {
  it('formats open and result copy without identities or URLs', () => {
    resetPlaylistVoteAnnounceDedupeForTests();
    const open = formatPlaylistVoteAnnounce({ type: 'announce_open', vote: vote() });
    assert.match(open, /Playlist vote: "Chill" \(3 tracks\)/);
    assert.match(open, /1 yes, needs 2 of 3/);
    assert.match(open, /60s/);
    assert.match(open, /!playlistvote yes/);
    assert.equal(open.includes('uid'), false);
    assert.equal(open.includes('http'), false);

    assert.equal(
      formatPlaylistVoteAnnounce({ type: 'announce_result', vote: vote({ status: 'passed', reason: 'approved' }) }),
      'Playlist vote passed: "Chill" (3 tracks) — queued.',
    );
    assert.equal(
      formatPlaylistVoteAnnounce({ type: 'announce_result', vote: vote({ status: 'cancelled', reason: 'cancelled' }) }),
      'Playlist vote cancelled: "Chill".',
    );
    assert.equal(
      formatPlaylistVoteAnnounce({
        type: 'announce_result',
        vote: vote({ status: 'failed', reason: 'deadline' }),
      }),
      'Playlist vote failed: "Chill" — not enough yes votes.',
    );
  });

  it('sanitizes and length-limits playlist names and messages', () => {
    assert.equal(sanitizePlaylistAnnounceName('  https://evil.example/x  Cool\nMix  '), 'Cool Mix');
    assert.equal(sanitizePlaylistAnnounceName('a'.repeat(80)).length, 64);
    assert.match(sanitizePlaylistAnnounceName('a'.repeat(80)), /…$/);
    const hostile = formatPlaylistVoteAnnounce({
      type: 'announce_open',
      vote: vote({
        playlist: {
          id: 1,
          name: `leak https://token.example/abc\n${'x'.repeat(200)}`,
          trackCount: 1,
        },
      }),
    });
    assert.equal(hostile.includes('http'), false);
    assert.equal(hostile.includes('\n'), false);
    assert.ok(hostile.length <= 400);
  });

  it('delivers only announce events in the bot channel and ignores send failures', () => {
    resetPlaylistVoteAnnounceDedupeForTests();
    const messages: string[] = [];
    const bot = {
      channelId: 8,
      getCurrentChannelId: () => bot.channelId,
      sendChannelMessage: (msg: string) => { messages.push(msg); },
    };
    const events: PlaylistVoteEvent[] = [
      { type: 'announce_open', vote: vote() },
      { type: 'queue', playlistId: 1, trackCount: 3, voteId: vote().id },
      { type: 'announce_result', vote: vote({ status: 'passed', reason: 'approved' }) },
    ];

    deliverPlaylistVoteAnnouncements(bot, 8, events);
    assert.equal(messages.length, 2);
    assert.match(messages[0]!, /Playlist vote: "Chill"/);
    assert.match(messages[1]!, /passed/);

    // Concurrent re-delivery of the same vote events is suppressed.
    deliverPlaylistVoteAnnouncements(bot, 8, events);
    assert.equal(messages.length, 2);

    messages.length = 0;
    bot.channelId = 99;
    resetPlaylistVoteAnnounceDedupeForTests();
    deliverPlaylistVoteAnnouncements(bot, 8, events);
    assert.deepEqual(messages, []);

    bot.channelId = 8;
    bot.sendChannelMessage = () => { throw new Error('flood'); };
    resetPlaylistVoteAnnounceDedupeForTests();
    assert.doesNotThrow(() => deliverPlaylistVoteAnnouncements(bot, 8, events));
  });

  it('skips delivery when the bot cannot send channel chat', () => {
    resetPlaylistVoteAnnounceDedupeForTests();
    assert.doesNotThrow(() => deliverPlaylistVoteAnnouncements(null, 8, [
      { type: 'announce_open', vote: vote() },
    ]));
    assert.doesNotThrow(() => deliverPlaylistVoteAnnouncements({
      getCurrentChannelId: () => 8,
    }, 8, [{ type: 'announce_open', vote: vote() }]));
  });
});
