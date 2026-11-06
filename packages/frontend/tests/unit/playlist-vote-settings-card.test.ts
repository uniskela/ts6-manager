import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { playlistVoteApprovalsNeeded } from '@ts6/common';
import { parseVoteIntegerField } from '../../src/components/bots/PlaylistVoteSettingsCard';

describe('parseVoteIntegerField', () => {
  it('accepts whole numbers in range', () => {
    assert.deepEqual(parseVoteIntegerField('80', 1, 100, 'Pass threshold'), { ok: true, value: 80 });
    assert.deepEqual(parseVoteIntegerField(' 25 ', 1, 500, 'Maximum request size'), { ok: true, value: 25 });
  });

  it('rejects empty, fractional and out-of-range values', () => {
    assert.equal(parseVoteIntegerField('', 1, 100, 'Pass threshold').ok, false);
    assert.equal(parseVoteIntegerField('80.5', 1, 100, 'Pass threshold').ok, false);
    assert.equal(parseVoteIntegerField('0', 1, 100, 'Pass threshold').ok, false);
    assert.equal(parseVoteIntegerField('101', 1, 100, 'Pass threshold').ok, false);
    assert.equal(parseVoteIntegerField('abc', 1, 100, 'Pass threshold').ok, false);
  });
});

describe('playlistVoteApprovalsNeeded parity with B2', () => {
  it('matches the #442 80% table and clamps the threshold', () => {
    const cases: Array<[number, number]> = [
      [1, 1], [2, 2], [3, 3], [4, 4], [5, 4], [6, 5], [10, 8],
    ];
    for (const [listeners, needed] of cases) {
      assert.equal(playlistVoteApprovalsNeeded(80, listeners), needed, `listeners=${listeners}`);
    }
    assert.equal(playlistVoteApprovalsNeeded(0, 5), playlistVoteApprovalsNeeded(1, 5));
    assert.equal(playlistVoteApprovalsNeeded(150, 5), playlistVoteApprovalsNeeded(100, 5));
    assert.equal(playlistVoteApprovalsNeeded(80.9, 5), playlistVoteApprovalsNeeded(80, 5));
  });

  it('treats an empty electorate defensively while openVote must still refuse it', () => {
    assert.equal(playlistVoteApprovalsNeeded(80, 0), 1);
  });
});
