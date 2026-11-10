import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publicMediaTitle, safeUrlDisplayTitle } from '../media-session.js';
import {
  addUrlToPlaylist,
  formatPlaylistTracks,
  removeTrackFromPlaylist,
  trackMatchLabels,
} from './library.js';

function catalog(playlists: Array<Record<string, unknown>>) {
  const songs: any[] = [];
  const links: any[] = [];
  let nextSong = 1;
  const db: any = {
    playlist: {
      findMany: async () => playlists.map((p) => ({ id: p.id, name: p.name })),
      findFirst: async ({ where }: any) => {
        const byId = playlists.find((p) => p.id === where.id);
        if (!byId) return null;
        return {
          ...byId,
          songs: links
            .filter((l) => l.playlistId === byId.id)
            .sort((a, b) => a.position - b.position)
            .map((l) => ({ position: l.position, song: songs.find((s) => s.id === l.songId) })),
        };
      },
    },
    song: {
      findFirst: async ({ where }: any) =>
        songs.find((s) => s.sourceUrl === where.sourceUrl && s.serverConfigId === where.serverConfigId) ?? null,
      create: async ({ data }: any) => {
        const created = { id: nextSong++, ...data };
        songs.push(created);
        return created;
      },
    },
    playlistSong: {
      findUnique: async ({ where }: any) => {
        const key = where.playlistId_songId;
        return links.find((l) => l.playlistId === key.playlistId && l.songId === key.songId) ?? null;
      },
      create: async ({ data }: any) => {
        links.push(data);
        return data;
      },
      deleteMany: async ({ where }: any) => {
        for (let i = links.length - 1; i >= 0; i -= 1) {
          if (links[i].playlistId === where.playlistId && links[i].songId === where.songId) {
            links.splice(i, 1);
          }
        }
        return { count: 1 };
      },
      aggregate: async ({ where }: any) => {
        const positions = links.filter((l) => l.playlistId === where.playlistId).map((l) => l.position);
        return { _max: { position: positions.length ? Math.max(...positions) : null } };
      },
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
    _songs: songs,
    _links: links,
  };
  return db;
}

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
    const db = catalog([{
      id: 1, name: 'Live Smoke', mode: 'stream', youtubePlaylistId: null, serverConfigId: 9,
    }]);
    const added = await addUrlToPlaylist(db, { query: 'Live Smoke', url, serverConfigId: 9 });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal(added.position, 1);
    assert.equal(added.title, display);
    // Enrichment replaces the stored title after insert (as live INT-TEST did).
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
    const db = catalog([{
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

  it('refuses ambiguous duplicate titles and points at /playlist tracks', async () => {
    const db = catalog([{
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
    const db = catalog([{
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
