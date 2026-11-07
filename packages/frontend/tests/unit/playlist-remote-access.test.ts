import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLAYLIST_REMOTE_ACCESS_LIBRARY_NOTE,
  PLAYLIST_REMOTE_ACCESS_OPTIONS,
  normalizePlaylistRemoteAccess,
  playlistRemoteAccessLabel,
} from '../../src/pages/media-bots/shared';

describe('playlist remoteAccess labels (A2)', () => {
  it('covers Hidden, Browse and Request with plain-language labels', () => {
    assert.deepEqual(
      PLAYLIST_REMOTE_ACCESS_OPTIONS.map((o) => o.value),
      ['hidden', 'browse', 'request'],
    );
    assert.equal(playlistRemoteAccessLabel('hidden'), 'Hidden');
    assert.equal(playlistRemoteAccessLabel('browse'), 'Browse');
    assert.equal(playlistRemoteAccessLabel('request'), 'Request');
  });

  it('defaults unknown or missing values to hidden', () => {
    assert.equal(normalizePlaylistRemoteAccess(undefined), 'hidden');
    assert.equal(normalizePlaylistRemoteAccess(null), 'hidden');
    assert.equal(normalizePlaylistRemoteAccess('public'), 'hidden');
    assert.equal(playlistRemoteAccessLabel(undefined), 'Hidden');
  });

  it('notes that hiding a playlist does not hide its songs from the remote library', () => {
    assert.match(PLAYLIST_REMOTE_ACCESS_LIBRARY_NOTE, /does not hide its songs/i);
    assert.match(PLAYLIST_REMOTE_ACCESS_LIBRARY_NOTE, /listener remote library/i);
  });
});
