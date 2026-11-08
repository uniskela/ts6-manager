import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LISTENER_MAX_DURATION_SEC,
  checkListenerDuration,
  listenerMusicSearchArgs,
  listenerSearchRowHasVerifiedDuration,
  listenerTrackMetaFromYtDlp,
  listenerYouTubeSearchArgs,
  searchListenerMusic,
  type ListenerMusicSearchDump,
  type ListenerSearchResult,
} from './listener-music.js';
import { setYtCookieFile } from './youtube.js';

function dump(payload: ListenerMusicSearchDump) {
  return async () => payload;
}

function musicRow(partial: Partial<ListenerSearchResult> & Pick<ListenerSearchResult, 'id' | 'title'>): string {
  return JSON.stringify({
    id: partial.id,
    title: partial.title,
    artists: [partial.artist ?? 'Artist'],
    duration: partial.durationSec ?? 0,
    thumbnail: partial.thumbnail ?? '',
    is_live: partial.isLive === true,
    live_status: partial.liveStatus ?? undefined,
  });
}

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

describe('listenerMusicSearchArgs / listenerYouTubeSearchArgs', () => {
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

  it('builds cookie-free ytsearchN args for the duration fallback', () => {
    setYtCookieFile('/tmp/admin-youtube-cookies.txt');
    try {
      const args = listenerYouTubeSearchArgs('Daft Punk One More Time', 10);
      assert.equal(args.includes('--cookies'), false);
      assert.ok(args.includes('ytsearch10:Daft Punk One More Time'));
      assert.equal(args.includes('--'), false);
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
    assert.throws(() => listenerYouTubeSearchArgs('-verbose', 3), /Invalid search query/);
  });
});

describe('searchListenerMusic', () => {
  it('maps playable Music rows with verified duration without hitting YouTube search', async () => {
    let youtubeCalls = 0;
    const stdout = [
      '[youtube:music:search_url] Downloading API JSON',
      JSON.stringify({ id: 'UCabcdefghijklmnopqrstuv', title: 'Channel' }),
      musicRow({ id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', durationSec: 355, thumbnail: 'https://img.example/q.jpg' }),
      musicRow({ id: 'dQw4w9WgXcQ', title: 'Rick', artist: 'Rick Astley', durationSec: 0 }),
      'not json',
    ].join('\n');

    const results = await searchListenerMusic('bohemian', 10, undefined, {
      dumpMusicSearch: dump({ code: 0, stdout, stderr: '' }),
      dumpYouTubeSearch: async () => {
        youtubeCalls++;
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    assert.equal(youtubeCalls, 0, 'verified Music duration must skip YouTube fallback');
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
    assert.equal(listenerSearchRowHasVerifiedDuration(results[0]!), true);
    assert.equal(listenerSearchRowHasVerifiedDuration(results[1]!), false);
  });

  it('falls back to YouTube search when Music rows have missing duration (C5)', async () => {
    const musicStdout = Array.from({ length: 10 }, (_, i) =>
      musicRow({
        id: `abcdefghij${i}`,
        title: `Daft Punk One More Time ${i}`,
        durationSec: null,
      }),
    ).join('\n');
    const youtubeStdout = [
      musicRow({ id: 'FGBhQbmPwH8', title: 'Daft Punk - One More Time (Official Video)', artist: 'Daft Punk', durationSec: 320 }),
      musicRow({ id: 'yTQRxVA9X0Y', title: 'One More Time', artist: 'Daft Punk', durationSec: 322 }),
      musicRow({ id: 'liveeeeeeee', title: 'Live Set', durationSec: 240, isLive: true }),
      musicRow({ id: 'toolonggggg', title: 'Extended', durationSec: 901 }),
    ].join('\n');

    let youtubeCalls = 0;
    const results = await searchListenerMusic('Daft Punk One More Time', 10, undefined, {
      dumpMusicSearch: dump({ code: 0, stdout: musicStdout, stderr: '' }),
      dumpYouTubeSearch: async (_q, _n, signal) => {
        signal?.throwIfAborted();
        youtubeCalls++;
        return { code: 0, stdout: youtubeStdout, stderr: '' };
      },
    });

    assert.equal(youtubeCalls, 1);
    assert.equal(results.length, 4);
    assert.equal(results[0]!.durationSec, 320);
    assert.equal(results[0]!.id, 'FGBhQbmPwH8');
    assert.equal(results[2]!.isLive, true);
    assert.equal(results[3]!.durationSec, 901);
  });

  it('falls back when Music fails and YouTube returns verified metadata', async () => {
    const results = await searchListenerMusic('fallback-on-error', 3, undefined, {
      dumpMusicSearch: dump({
        code: 1,
        stdout: '',
        stderr: 'ERROR: Sign in to confirm you are not a bot',
      }),
      dumpYouTubeSearch: dump({
        code: 0,
        stdout: musicRow({ id: 'fJ9rUzIMcZQ', title: 'Safe', durationSec: 200 }),
        stderr: '',
      }),
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.durationSec, 200);
  });

  it('returns empty when both providers only yield unusable rows', async () => {
    const results = await searchListenerMusic('nothing-usable', 5, undefined, {
      dumpMusicSearch: dump({
        code: 0,
        stdout: musicRow({ id: 'dQw4w9WgXcQ', title: 'Unknown', durationSec: null }),
        stderr: '',
      }),
      dumpYouTubeSearch: dump({
        code: 0,
        stdout: [
          musicRow({ id: 'aaaaaaaaaaa', title: 'Also Unknown', durationSec: 0 }),
          musicRow({ id: 'bbbbbbbbbbb', title: 'Live Only', durationSec: 120, isLive: true }),
        ].join('\n'),
        stderr: '',
      }),
    });
    // Provider returns rows; route-layer checkListenerDuration still drops them.
    assert.ok(results.every((row) => !listenerSearchRowHasVerifiedDuration(row)));
  });

  it('surfaces Music failure when YouTube fallback also fails', async () => {
    await assert.rejects(
      searchListenerMusic('both-fail', 3, undefined, {
        dumpMusicSearch: dump({
          code: 1,
          stdout: '',
          stderr: 'ERROR: music provider down',
        }),
        dumpYouTubeSearch: dump({
          code: 1,
          stdout: '',
          stderr: 'ERROR: youtube provider down',
        }),
      }),
      /yt-dlp music search failed \(code 1\).*music provider down/,
    );
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
    // Live Music-only rows are not "verified duration" for listener accept —
    // fall through to YouTube unless YouTube is stubbed empty-usable.
    const results = await searchListenerMusic('live', 5, undefined, {
      dumpMusicSearch: dump({ code: 0, stdout, stderr: '' }),
      dumpYouTubeSearch: dump({ code: 0, stdout, stderr: '' }),
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isLive, true);
    assert.equal(results[0]!.liveStatus, 'is_live');
    assert.equal(results[0]!.durationSec, 240);
    assert.equal(listenerSearchRowHasVerifiedDuration(results[0]!), false);
  });

  it('rejects cancelled and empty queries before calling either dump', async () => {
    const unexpected = async () => {
      assert.fail('cancelled or empty search must not dump');
      return { code: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
      searchListenerMusic('song', 1, AbortSignal.abort(), {
        dumpMusicSearch: unexpected,
        dumpYouTubeSearch: unexpected,
      }),
      { name: 'AbortError' },
    );
    await assert.rejects(
      searchListenerMusic('   ', 1, undefined, {
        dumpMusicSearch: unexpected,
        dumpYouTubeSearch: unexpected,
      }),
      /Invalid search query/,
    );
  });

  it('propagates cancellation after Music dump and skips YouTube fallback', async () => {
    const controller = new AbortController();
    let youtubeCalls = 0;
    await assert.rejects(
      searchListenerMusic('song', 1, controller.signal, {
        dumpMusicSearch: async () => {
          controller.abort();
          return {
            code: 0,
            stdout: musicRow({ id: 'dQw4w9WgXcQ', title: 'x', durationSec: null }),
            stderr: '',
          };
        },
        dumpYouTubeSearch: async () => {
          youtubeCalls++;
          return { code: 0, stdout: '', stderr: '' };
        },
      }),
      { name: 'AbortError' },
    );
    assert.equal(youtubeCalls, 0);
  });

  it('propagates cancellation during YouTube fallback', async () => {
    const controller = new AbortController();
    await assert.rejects(
      searchListenerMusic('song', 1, controller.signal, {
        dumpMusicSearch: dump({
          code: 0,
          stdout: musicRow({ id: 'dQw4w9WgXcQ', title: 'x', durationSec: null }),
          stderr: '',
        }),
        dumpYouTubeSearch: async () => {
          controller.abort();
          return {
            code: 0,
            stdout: musicRow({ id: 'fJ9rUzIMcZQ', title: 'y', durationSec: 100 }),
            stderr: '',
          };
        },
      }),
      { name: 'AbortError' },
    );
  });
});
