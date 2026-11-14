import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publicMediaTitle, safeUrlDisplayTitle } from '../media-session.js';
import {
  addUrlToPlaylist,
  formatPlaylistTracks,
  listPlaylistTracks,
  removeTrackFromPlaylist,
  trackMatchLabels,
} from './library.js';
import { fakePlaylistCatalog } from './library.test-catalog.js';

describe('playlist remove matching (finding #18)', () => {
  const url = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
  const display = safeUrlDisplayTitle(url);

  it('exposes display and stored titles as match labels', () => {
    const labels = trackMatchLabels({ title: 'SoundHelix-Song-1', sourceUrl: url });
    assert.ok(labels.includes('SoundHelix-Song-1'));
    assert.ok(labels.includes(display));
    assert.equal(publicMediaTitle('SoundHelix-Song-1', url), 'SoundHelix-Song-1');
  });

  it('removes by the add-time display title after metadata enrichment', async () => {
    const db = fakePlaylistCatalog([{
      id: 1, name: 'Live Smoke', mode: 'stream', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    const added = await addUrlToPlaylist(db, { query: 'Live Smoke', url, serverConfigId: 9 });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal(added.position, 1);
    assert.equal(added.title, display);
    db._songs[0].title = 'SoundHelix-Song-1';
    const byDisplay = await removeTrackFromPlaylist(db, {
      query: 'Live Smoke',
      track: display,
      serverConfigId: 9,
    });
    assert.equal(byDisplay.ok, true);
    assert.equal(db._links.length, 0);
  });

  it('removes by unambiguous position from /playlist tracks', async () => {
    const db = fakePlaylistCatalog([{
      id: 2, name: 'Ordered', mode: 'stream', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    await addUrlToPlaylist(db, {
      query: 'Ordered', url: 'https://example.test/a.mp3', serverConfigId: 9,
    });
    await addUrlToPlaylist(db, {
      query: 'Ordered', url: 'https://example.test/b.mp3', serverConfigId: 9,
    });
    const listing = formatPlaylistTracks('Ordered', [
      { position: 0, song: db._songs[0] },
      { position: 1, song: db._songs[1] },
    ]);
    assert.match(listing, /\[#1\]/);
    assert.match(listing, /\[#2\]/);
    const removed = await removeTrackFromPlaylist(db, {
      query: 'Ordered', track: '#2', serverConfigId: 9,
    });
    assert.equal(removed.ok, true);
    assert.equal(db._links.length, 1);
    assert.equal(db._links[0].songId, db._songs[0].id);
  });

  it('keeps add/tracks/remove on the same #N after delete then add', async () => {
    const db = fakePlaylistCatalog([{
      id: 5, name: 'Ordinal', mode: 'stream', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    const a = await addUrlToPlaylist(db, {
      query: 'Ordinal', url: 'https://example.test/a.mp3', serverConfigId: 9,
    });
    const b = await addUrlToPlaylist(db, {
      query: 'Ordinal', url: 'https://example.test/b.mp3', serverConfigId: 9,
    });
    const c = await addUrlToPlaylist(db, {
      query: 'Ordinal', url: 'https://example.test/c.mp3', serverConfigId: 9,
    });
    assert.equal(a.ok && a.position, 1);
    assert.equal(b.ok && b.position, 2);
    assert.equal(c.ok && c.position, 3);
    const removedFirst = await removeTrackFromPlaylist(db, {
      query: 'Ordinal', track: '1', serverConfigId: 9,
    });
    assert.equal(removedFirst.ok, true);
    const fourth = await addUrlToPlaylist(db, {
      query: 'Ordinal', url: 'https://example.test/d.mp3', serverConfigId: 9,
    });
    assert.equal(fourth.ok, true);
    if (!fourth.ok) return;
    // After deleting #1, remaining were #1,#2; new track is #3 (not raw DB position+1).
    assert.equal(fourth.position, 3);
    const listing = await listPlaylistTracks(db, { query: 'Ordinal', serverConfigId: 9 });
    assert.equal(listing.ok, true);
    if (!listing.ok) return;
    assert.match(listing.message, /\[#3\].*Media from example\.test/);
    assert.equal(fourth.position, 3);
    const songD = db._songs.find((s: any) => s.sourceUrl === 'https://example.test/d.mp3');
    assert.ok(songD);
    const removed = await removeTrackFromPlaylist(db, {
      query: 'Ordinal', track: String(fourth.position), serverConfigId: 9,
    });
    assert.equal(removed.ok, true);
    assert.equal(db._links.some((l: any) => l.songId === songD.id), false);
    assert.equal(db._links.length, 2);
  });

  it('refuses ambiguous duplicate titles and points at /playlist tracks', async () => {
    const db = fakePlaylistCatalog([{
      id: 3, name: 'Dupes', mode: 'stream', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    await addUrlToPlaylist(db, {
      query: 'Dupes', url: 'https://example.test/one.mp3', serverConfigId: 9,
    });
    await addUrlToPlaylist(db, {
      query: 'Dupes', url: 'https://example.test/two.mp3', serverConfigId: 9,
    });
    db._songs[0].title = 'Same Title';
    db._songs[1].title = 'Same Title';
    const denied = await removeTrackFromPlaylist(db, {
      query: 'Dupes', track: 'Same Title', serverConfigId: 9,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.match(denied.message, /Ambiguous track.*\/playlist tracks/);
    assert.equal(db._links.length, 2);
  });

  it('blocks unauthorised removal of shared/foreign playlists', async () => {
    const db = fakePlaylistCatalog([{
      id: 4, name: 'Shared', mode: 'stream', youtubePlaylistId: null, serverConfigId: null,
    }]);
    db._songs.push({
      id: 99, title: 'Clip', sourceUrl: 'https://example.test/x.mp3', serverConfigId: null,
    });
    db._links.push({ playlistId: 4, songId: 99, position: 0 });
    const denied = await removeTrackFromPlaylist(db, {
      query: 'Shared', track: '1', serverConfigId: 9,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.match(denied.message, /cannot be edited/);
    assert.equal(db._links.length, 1);
  });
});
