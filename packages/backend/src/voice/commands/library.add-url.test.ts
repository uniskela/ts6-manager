import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addUrlToPlaylist,
  effectivePlaylistMode,
  playlistModeMismatchMessage,
  songMatchesMode,
  urlAddSongSource,
} from './library.js';
import { fakePlaylistCatalog as catalog } from './library.test-catalog.js';

describe('playlist mode helpers (shared REST + Discord)', () => {
  it('treats missing/null mode as local and YouTube-import as stream', () => {
    assert.equal(effectivePlaylistMode({ mode: 'local' }), 'local');
    assert.equal(effectivePlaylistMode({ mode: 'stream' }), 'stream');
    assert.equal(effectivePlaylistMode({ mode: null as any }), 'local');
    assert.equal(effectivePlaylistMode({ mode: 'local', youtubePlaylistId: 'PLxxx' }), 'stream');
  });

  it('matches sources the same way REST does', () => {
    assert.equal(songMatchesMode('local', 'local'), true);
    assert.equal(songMatchesMode('url', 'local'), false);
    assert.equal(songMatchesMode('youtube', 'local'), false);
    assert.equal(songMatchesMode('url', 'stream'), true);
    assert.equal(songMatchesMode('youtube', 'stream'), true);
    assert.equal(songMatchesMode('local', 'stream'), false);
  });
});

describe('addUrlToPlaylist mode gate (finding #10)', () => {
  it('rejects an external URL on a local playlist without creating Song or PlaylistSong rows', async () => {
    const db = catalog([{
      id: 1, name: 'Local Only', mode: 'local', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    const result = await addUrlToPlaylist(db, {
      query: 'Local Only',
      url: 'https://8.8.8.8/track.mp3',
      serverConfigId: 9,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.message, playlistModeMismatchMessage('local'));
    }
    assert.equal(db._songs.length, 0);
    assert.equal(db._links.length, 0);
  });

  it('rejects YouTube URLs on local playlists before mutation', async () => {
    const db = catalog([{
      id: 2, name: 'Files', mode: 'local', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    const result = await addUrlToPlaylist(db, {
      query: 'Files',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      serverConfigId: 9,
    });
    assert.equal(result.ok, false);
    assert.equal(urlAddSongSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube');
    assert.equal(db._songs.length, 0);
    assert.equal(db._links.length, 0);
  });

  it('accepts a supported URL on a stream playlist', async () => {
    const db = catalog([{
      id: 3, name: 'Stream Mix', mode: 'stream', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    const result = await addUrlToPlaylist(db, {
      query: 'Stream Mix',
      url: 'https://8.8.8.8/ok.mp3',
      serverConfigId: 9,
    });
    assert.equal(result.ok, true);
    assert.equal(db._songs.length, 1);
    assert.equal(db._songs[0].source, 'url');
    assert.equal(db._songs[0].sourceUrl, 'https://8.8.8.8/ok.mp3');
    assert.equal(db._songs[0].title, 'Media from 8.8.8.8');
    assert.doesNotMatch(db._songs[0].title, /ok\.mp3/);
    assert.equal(db._links.length, 1);
  });

  it('finding #9: never stores password or query token in the song title', async () => {
    const db = catalog([{
      id: 30, name: 'Stream', mode: 'stream', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    const url = 'https://dj:tok_en@cdn.example.test/live.m3u8?access_token=sekrit';
    const result = await addUrlToPlaylist(db, {
      query: 'Stream',
      url,
      serverConfigId: 9,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.title, 'Media from cdn.example.test');
      assert.doesNotMatch(result.title, /tok_en|sekrit|dj:/);
    }
    assert.equal(db._songs[0].sourceUrl, url);
    assert.doesNotMatch(db._songs[0].title, /tok_en|sekrit|dj:/);
  });

  it('treats legacy/null mode like REST (local) and refuses URL add', async () => {
    const db = catalog([{
      id: 4, name: 'Legacy', mode: null, youtubePlaylistId: null, serverConfigId: 9,
    }]);
    const result = await addUrlToPlaylist(db, {
      query: 'Legacy',
      url: 'https://8.8.8.8/x.mp3',
      serverConfigId: 9,
    });
    assert.equal(result.ok, false);
    assert.equal(db._songs.length, 0);
  });

  it('allows URL add when youtubePlaylistId forces stream despite local mode column', async () => {
    const db = catalog([{
      id: 5, name: 'Imported', mode: 'local', youtubePlaylistId: 'PLabc', serverConfigId: 9,
    }]);
    const result = await addUrlToPlaylist(db, {
      query: 'Imported',
      url: 'https://8.8.8.8/yt.mp3',
      serverConfigId: 9,
    });
    assert.equal(result.ok, true);
    assert.equal(db._links.length, 1);
  });

  it('leaves existing local-media playlist songs untouched on rejected URL add', async () => {
    const db = catalog([{
      id: 6, name: 'Local Lib', mode: 'local', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    db._songs.push({
      id: 99, title: 'On Disk', source: 'local', sourceUrl: null, serverConfigId: 9, filePath: '/tmp/a',
    });
    db._links.push({ playlistId: 6, songId: 99, position: 0 });
    const beforeSongs = db._songs.length;
    const beforeLinks = db._links.length;
    const result = await addUrlToPlaylist(db, {
      query: 'Local Lib',
      url: 'https://8.8.8.8/external.mp3',
      serverConfigId: 9,
    });
    assert.equal(result.ok, false);
    assert.equal(db._songs.length, beforeSongs);
    assert.equal(db._links.length, beforeLinks);
    assert.equal(db._songs[0].source, 'local');
  });

  it('repeated rejected attempts still mutate nothing', async () => {
    const db = catalog([{
      id: 7, name: 'Local', mode: 'local', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    for (let i = 0; i < 3; i++) {
      const result = await addUrlToPlaylist(db, {
        query: 'Local',
        url: 'https://8.8.8.8/again.mp3',
        serverConfigId: 9,
      });
      assert.equal(result.ok, false);
    }
    assert.equal(db._songs.length, 0);
    assert.equal(db._links.length, 0);
  });
});
