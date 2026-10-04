import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapRadioBrowserStation,
  recordRadioBrowserClick,
  resetRadioBrowserMirrorCache,
  searchRadioBrowserStations,
  shuffleInPlace,
} from './radio-browser.js';

describe('radio-browser client', () => {
  it('maps resolved stream URL, tags and favicon', () => {
    const mapped = mapRadioBrowserStation({
      stationuuid: '01234567-89ab-cdef-0123-456789abcdef',
      name: ' Jazz Radio ',
      url: 'http://example.com/playlist.pls',
      url_resolved: 'https://stream.example.com/mp3',
      tags: 'jazz, chill, late night, unused',
      favicon: 'https://example.com/icon.png',
      countrycode: 'de',
      codec: 'MP3',
      bitrate: 128,
    });
    assert.deepEqual(mapped, {
      stationuuid: '01234567-89ab-cdef-0123-456789abcdef',
      name: 'Jazz Radio',
      url: 'https://stream.example.com/mp3',
      genre: 'jazz, chill, late night',
      imageUrl: 'https://example.com/icon.png',
      countrycode: 'DE',
      codec: 'MP3',
      bitrate: 128,
    });
  });

  it('rejects stations without a usable http(s) stream URL', () => {
    assert.equal(mapRadioBrowserStation({ stationuuid: 'x', name: 'A', url: 'ftp://x' }), null);
    assert.equal(mapRadioBrowserStation({ stationuuid: '', name: 'A', url: 'https://x' }), null);
  });

  it('shuffles deterministically with a fixed random source', () => {
    const items = [1, 2, 3, 4];
    let i = 0;
    const seq = [0, 0, 0];
    shuffleInPlace(items, () => seq[i++] ?? 0);
    assert.deepEqual(items, [2, 3, 4, 1]);
  });

  it('searches with lastcheckok/hls filters and fails over to the next mirror', async () => {
    resetRadioBrowserMirrorCache();
    const urls: string[] = [];
    const stations = await searchRadioBrowserStations(
      { name: 'bbc', limit: 5 },
      {
        resolveMirrors: async () => ['down.example', 'up.example'],
        // Keep list order: Fisher–Yates with r≈1 always picks j=i.
        random: () => 0.999,
        httpGet: async (url) => {
          urls.push(url);
          if (url.includes('down.example')) throw new Error('down');
          assert.match(url, /lastcheckok=1/);
          assert.match(url, /hls=0/);
          assert.match(url, /name=bbc/);
          assert.match(url, /limit=5/);
          return [{
            stationuuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            name: 'BBC',
            url_resolved: 'https://stream.example/live',
            tags: 'pop',
            favicon: '',
            countrycode: 'GB',
            codec: 'MP3',
            bitrate: 128,
          }];
        },
      },
    );
    assert.equal(stations.length, 1);
    assert.equal(stations[0].name, 'BBC');
    assert.deepEqual(urls.map((u) => new URL(u).hostname), ['down.example', 'up.example']);
  });

  it('requires at least one search field', async () => {
    await assert.rejects(searchRadioBrowserStations({}), /Provide a search/);
  });

  it('records a click against the first working mirror', async () => {
    const urls: string[] = [];
    await recordRadioBrowserClick('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      resolveMirrors: async () => ['a.example', 'b.example'],
      random: () => 0.999,
      httpGet: async (url) => {
        urls.push(url);
        if (url.includes('a.example')) throw new Error('fail');
        return { ok: true };
      },
    });
    assert.equal(urls.length, 2);
    assert.match(urls[1], /\/json\/url\/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee$/);
  });

  it('ignores invalid click uuids', async () => {
    let called = 0;
    await recordRadioBrowserClick('not-a-uuid', {
      resolveMirrors: async () => { called++; return ['x']; },
      httpGet: async () => { called++; return {}; },
    });
    assert.equal(called, 0);
  });
});
