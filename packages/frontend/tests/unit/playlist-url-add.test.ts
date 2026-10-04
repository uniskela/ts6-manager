import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunk, playlistAddMessage, urlInfoPlaylistLabel } from '../../src/pages/media-bots/shared';

const item = (id: string) => ({ id, title: id, artist: 'A', duration: 60, thumbnail: '' }) as any;

describe('playlist URL add', () => {
  it('labels loaded links as tracks, not videos', () => {
    assert.equal(urlInfoPlaylistLabel({ type: 'playlist', items: ['a', 'b'].map(item) }), '2 tracks');
    assert.equal(urlInfoPlaylistLabel({ type: 'playlist', items: [item('a')] }), '1 track');
    assert.equal(urlInfoPlaylistLabel({ type: 'video', items: [item('a')] }), 'Single track');
  });

  it('splits register requests to the server limit', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 200), []);
  });

  it('counts only tracks that were new to the playlist', () => {
    assert.equal(
      playlistAddMessage({ added: 40, alreadyInPlaylist: 22, playlistName: 'Music', stream: true }),
      'Added 40 tracks to Music (22 already there). Nothing downloads until played.',
    );
    assert.equal(
      playlistAddMessage({ added: 1, alreadyInPlaylist: 0, playlistName: 'Music', stream: false }),
      'Added 1 track to Music',
    );
  });

  it('says so when everything was already there', () => {
    assert.equal(
      playlistAddMessage({ added: 0, alreadyInPlaylist: 62, playlistName: 'Music', stream: true }),
      'All selected tracks are already in Music',
    );
    assert.equal(
      playlistAddMessage({ added: 0, alreadyInPlaylist: 1, playlistName: 'Music', stream: true }),
      'That track is already in Music',
    );
  });
});
