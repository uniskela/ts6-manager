import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MediaSessionConflictBody } from '@ts6/common';
import {
  conflictIsReplaceable,
  describeMediaSession,
  isMediaSessionConflict,
  withReplaceSessionIds,
} from '../../src/lib/media-switch';

const conflict: MediaSessionConflictBody = {
  error: 'Music is playing on Aurora.',
  reason: 'media_session_conflict',
  requested: 'video',
  conflicts: [
    { id: 'a', kind: 'music', state: 'active', botId: 1, botName: 'Aurora', startedAt: 0, label: 'Neon Skyline' },
    { id: 'b', kind: 'video', state: 'active', botId: 2, botName: 'Bravo', startedAt: 0, label: 'iptv.example' },
  ],
};

describe('media switch helpers', () => {
  it('recognizes only media conflicts', () => {
    assert.ok(isMediaSessionConflict(conflict));
    assert.ok(!isMediaSessionConflict({ error: 'Bot is not connected' }));
    assert.ok(!isMediaSessionConflict(null));
  });

  it('adds the confirmed IDs to any request body shape', () => {
    assert.deepEqual(withReplaceSessionIds('{"source":"x","preset":"auto"}', ['a']), {
      source: 'x', preset: 'auto', replaceSessionIds: ['a'],
    });
    assert.deepEqual(withReplaceSessionIds(undefined, ['a', 'b']), { replaceSessionIds: ['a', 'b'] });
    assert.deepEqual(withReplaceSessionIds({ songId: 3, replaceSessionIds: ['old'] }, ['a']), {
      songId: 3, replaceSessionIds: ['a'],
    });
  });

  it('describes sessions and blocks replacing one still starting', () => {
    assert.equal(describeMediaSession(conflict.conflicts[0]), 'Music “Neon Skyline” on Aurora');
    assert.equal(describeMediaSession(conflict.conflicts[1]), 'Video stream from iptv.example on Bravo');
    assert.ok(conflictIsReplaceable(conflict));
    assert.ok(!conflictIsReplaceable({
      ...conflict,
      conflicts: [{ ...conflict.conflicts[1], state: 'starting' }],
    }));
  });
});
