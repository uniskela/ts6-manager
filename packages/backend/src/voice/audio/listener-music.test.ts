import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LISTENER_MAX_DURATION_SEC,
  checkListenerDuration,
  listenerMusicSearchArgs,
  listenerTrackMetaFromYtDlp,
  searchListenerMusic,
  type ListenerMusicSearchDump,
} from './listener-music.js';
import { setYtCookieFile } from './youtube.js';

describe('checkListenerDuration', () => {
  it('accepts a track at or under 15 minutes', () => {
    assert.deepEqual(checkListenerDuration({ durationSec: 1 }), { ok: true, durationSec: 1 });
    assert.deepEqual(checkListenerDuration({ durationSec: LISTENER_MAX_DURATION_SEC }), {
      ok: true,
      durationSec: LISTENER_MAX_DURATION_SEC,
    });
  });

  it('refuses live streams before length', () => {
    assert.deepEqual(
      checkListenerDuration({ durationSec: 120, isLive: true }),
      { ok: false, reason: 'live_not_allowed' },
    );
    assert.deepEqual(
      checkListenerDuration({ durationSec: 120, liveStatus: 'is_live' }),
      { ok: false, reason: 'live_not_allowed' },
    );
  });

  it('refuses unknown duration', () => {
    for (const durationSec of [null, undefined, 0, -1, Number.NaN]) {
      assert.deepEqual(
        checkListenerDuration({ durationSec }),
        { ok: false, reason: 'unknown_duration' },
      );
    }
  });

  it('refuses tracks longer than 15 minutes', () => {
    assert.deepEqual(
      checkListenerDuration({ durationSec: LISTENER_MAX_DURATION_SEC + 1 }),
      { ok: false, reason: 'too_long' },
    );
  });
});

describe('listenerTrackMetaFromYtDlp', () => {
  it('maps live and duration fields for the pre-download check', () => {
    assert.deepEqual(
      listenerTrackMetaFromYtDlp({ is_live: true, duration: 600 }),
      { isLive: true, liveStatus: null, durationSec: 600 },
    );
    assert.deepEqual(
      listenerTrackMetaFromYtDlp({ live_status: 'is_live' }),
      { isLive: true, liveStatus: 'is_live', durationSec: null },
    );
    assert.deepEqual(
      listenerTrackMetaFromYtDlp({ is_live: false, duration: 214.4 }),
      { isLive: false, liveStatus: null, durationSec: 214.4 },
    );
    assert.deepEqual(
      listenerTrackMetaFromYtDlp({ duration: 0 }),
      { isLive: false, liveStatus: null, durationSec: null },
    );
  });
});

describe('listenerMusicSearchArgs', () => {
  it('never requests cookies and targets Music Songs', () => {
    setYtCookieFile('/tmp/admin-youtube-cookies.txt');
    try {
      const args = listenerMusicSearchArgs('  thunderstruck  ', 5);
      assert.equal(args.includes('--cookies'), false);
      assert.equal(args.at(-2), '--');
      assert.equal(args.at(-1), 'https://music.youtube.com/search?q=thunderstruck#songs');
      assert.equal(args[args.indexOf('--playlist-items') + 1], '1-5');
      for (const flag of ['--flat-playlist', '--dump-json', '--no-download']) {
        assert.ok(args.includes(flag));
      }
    } finally {
      setYtCookieFile(null);
    }
  });

  it('rejects empty and option-shaped queries', () => {
    assert.throws(() => listenerMusicSearchArgs('   ', 3), /Invalid search query/);
    assert.throws(() => listenerMusicSearchArgs('-verbose', 3), /Invalid search query/);
  });
});

describe('searchListenerMusic', () => {
  const dump = (payload: ListenerMusicSearchDump) => async () => payload;

  it('maps playable rows and skips non-video entries without hitting the network', async () => {
    const stdout = [
      '[youtube:music:search_url] Downloading API JSON',
      JSON.stringify({ id: 'UCabcdefghijklmnopqrstuv', title: 'Channel' }),
      JSON.stringify({
        id: 'fJ9rUzIMcZQ',
        title: 'Bohemian Rhapsody',
        artists: ['Queen'],
        duration: 355,
        thumbnail: 'https://img.example/q.jpg',
      }),
      JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'Rick', uploader: 'Rick Astley', duration: 0 }),
      'not json',
    ].join('\n');

    const results = await searchListenerMusic('bohemian', 10, undefined, {
      dumpMusicSearch: dump({ code: 0, stdout, stderr: '' }),
    });

    assert.deepEqual(results, [
      {
        id: 'fJ9rUzIMcZQ',
        title: 'Bohemian Rhapsody',
        artist: 'Queen',
        durationSec: 355,
        thumbnail: 'https://img.example/q.jpg',
        url: 'https://www.youtube.com/watch?v=fJ9rUzIMcZQ',
        isLive: false,
        liveStatus: null,
      },
      {
        id: 'dQw4w9WgXcQ',
        title: 'Rick',
        artist: 'Rick Astley',
        durationSec: null,
        thumbnail: '',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        isLive: false,
        liveStatus: null,
      },
    ]);
  });

  it('preserves live flags from flat search JSON for listener filtering', async () => {
    const stdout = JSON.stringify({
      id: 'dQw4w9WgXcQ',
      title: 'Live Show',
      artists: ['Band'],
      duration: 240,
      is_live: true,
      live_status: 'is_live',
    });
    const results = await searchListenerMusic('live', 5, undefined, {
      dumpMusicSearch: dump({ code: 0, stdout, stderr: '' }),
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isLive, true);
    assert.equal(results[0]!.liveStatus, 'is_live');
    assert.equal(results[0]!.durationSec, 240);
  });

  it('fails closed when yt-dlp exits non-zero', async () => {
    await assert.rejects(
      searchListenerMusic('q', 3, undefined, {
        dumpMusicSearch: dump({
          code: 1,
          stdout: JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'x', duration: 100 }),
          stderr: 'ERROR: Sign in to confirm you are not a bot',
        }),
      }),
      /yt-dlp music search failed \(code 1\).*Sign in/,
    );
  });

  it('rejects cancelled and empty queries before calling the dump', async () => {
    const unexpected = async () => {
      assert.fail('cancelled or empty search must not dump');
      return { code: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
      searchListenerMusic('song', 1, AbortSignal.abort(), { dumpMusicSearch: unexpected }),
      { name: 'AbortError' },
    );
    await assert.rejects(
      searchListenerMusic('   ', 1, undefined, { dumpMusicSearch: unexpected }),
      /Invalid search query/,
    );
  });

  it('propagates cancellation after a dump returns', async () => {
    const controller = new AbortController();
    await assert.rejects(
      searchListenerMusic('song', 1, controller.signal, {
        dumpMusicSearch: async () => {
          controller.abort();
          return {
            code: 0,
            stdout: JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'x', duration: 100 }),
            stderr: '',
          };
        },
      }),
      { name: 'AbortError' },
    );
  });
});
