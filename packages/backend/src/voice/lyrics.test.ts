import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { cleanTrackTitle, chunkLyrics, fetchLyrics, lyricsInputFromTrack } from './lyrics.js';

describe('cleanTrackTitle', () => {
  it('strips bracketed YouTube noise', () => {
    assert.equal(cleanTrackTitle('Bohemian Rhapsody (Official Video)'), 'Bohemian Rhapsody');
    assert.equal(cleanTrackTitle('Alors on danse [Clip Officiel]'), 'Alors on danse');
    assert.equal(cleanTrackTitle('Take on Me (Official 4K Video)'), 'Take on Me');
    assert.equal(cleanTrackTitle('Numb (Official Music Video) [HD]'), 'Numb');
    assert.equal(cleanTrackTitle('Shape of You (Lyrics)'), 'Shape of You');
  });

  it('keeps meaningful parentheses', () => {
    assert.equal(cleanTrackTitle('Time (You and I)'), 'Time (You and I)');
  });

  it('collapses leftover whitespace', () => {
    assert.equal(cleanTrackTitle('  Song   (Official Audio)  '), 'Song');
  });

  it('returns plain titles untouched', () => {
    assert.equal(cleanTrackTitle('Bohemian Rhapsody'), 'Bohemian Rhapsody');
  });
});

describe('chunkLyrics', () => {
  it('returns a single chunk when everything fits', () => {
    assert.deepEqual(chunkLyrics('HEAD', 'line1\nline2', 100), ['HEAD\nline1\nline2']);
  });

  it('splits on line boundaries, never mid-line', () => {
    const chunks = chunkLyrics('', 'aaaa\nbbbb\ncccc', 9);
    assert.deepEqual(chunks, ['aaaa\nbbbb', 'cccc']);
    for (const c of chunks) assert.ok(c.length <= 9);
  });

  it('puts the header in the first chunk only', () => {
    const chunks = chunkLyrics('🎤 Artist — Title', 'l1\nl2\nl3\nl4', 20);
    assert.ok(chunks[0].startsWith('🎤 Artist — Title'));
    assert.ok(chunks.length > 1);
    assert.ok(!chunks[1].includes('🎤'));
  });

  it('hard-splits a single line longer than maxLen (degenerate case)', () => {
    const chunks = chunkLyrics('', 'x'.repeat(25), 10);
    assert.deepEqual(chunks, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('drops empty/whitespace-only chunks', () => {
    assert.deepEqual(chunkLyrics('', '\n\n\n', 50), []);
  });

  it('works with an empty header (Discord mode)', () => {
    assert.deepEqual(chunkLyrics('', 'hello', 50), ['hello']);
  });
});

describe('lyricsInputFromTrack', () => {
  it('keeps a real artist in both input and label', () => {
    const { input, label } = lyricsInputFromTrack({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    assert.deepEqual(input, { artist: 'Queen', title: 'Bohemian Rhapsody' });
    assert.equal(label, 'Queen — Bohemian Rhapsody');
  });

  it('treats the "Unknown" sentinel as an absent artist', () => {
    const { input, label } = lyricsInputFromTrack({ artist: 'Unknown', title: 'Some Song' });
    assert.equal(input.artist, undefined);
    assert.equal(label, 'Some Song');
  });

  it('treats the "Unknown Artist" sentinel (Spotify metadata) as an absent artist', () => {
    const { input, label } = lyricsInputFromTrack({ artist: 'Unknown Artist', title: 'Some Song' });
    assert.equal(input.artist, undefined);
    assert.equal(label, 'Some Song');
  });

  it('cleans the title for search but keeps the raw title in the label', () => {
    const { input, label } = lyricsInputFromTrack({ artist: 'Artist', title: 'Song (Official Video)' });
    assert.equal(input.title, 'Song');
    assert.equal(label, 'Artist — Song (Official Video)');
  });

  it('handles a missing artist property', () => {
    const { input, label } = lyricsInputFromTrack({ title: 'Some Song' });
    assert.equal(input.artist, undefined);
    assert.equal(label, 'Some Song');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('fetchLyrics', () => {
  type FetchImpl = (...args: unknown[]) => Promise<Response>;
  let responses: FetchImpl[];
  let fetchMock: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    responses = [];
    fetchMock = mock.fn(async (...args: unknown[]) => {
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch call');
      return next(...args);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('returns the LRCLIB exact match first', async () => {
    responses.push(async () => jsonResponse({
      artistName: 'Queen', trackName: 'Bohemian Rhapsody',
      plainLyrics: 'Is this the real life?', instrumental: false,
    }));
    const r = await fetchLyrics({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    assert.deepEqual(
      { artist: r?.artist, lyrics: r?.lyrics, source: r?.source },
      { artist: 'Queen', lyrics: 'Is this the real life?', source: 'lrclib' },
    );
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.match(String(fetchMock.mock.calls[0].arguments[0]), /lrclib\.net\/api\/get\?/);
  });

  it('falls back to LRCLIB search when exact match 404s', async () => {
    responses.push(
      async () => jsonResponse({ message: 'not found' }, 404),
      async () => jsonResponse([
        { artistName: 'A', trackName: 'T', plainLyrics: '', instrumental: false },
        { artistName: 'Queen', trackName: 'Bohemian Rhapsody', plainLyrics: 'lyrics here', instrumental: false },
      ]),
    );
    const r = await fetchLyrics({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    assert.deepEqual(
      { lyrics: r?.lyrics, source: r?.source },
      { lyrics: 'lyrics here', source: 'lrclib' },
    );
    assert.match(String(fetchMock.mock.calls[1].arguments[0]), /lrclib\.net\/api\/search\?/);
  });

  it('skips the exact-match step for free-text queries', async () => {
    responses.push(async () => jsonResponse([
      { artistName: 'Queen', trackName: 'Bohemian Rhapsody', plainLyrics: 'found', instrumental: false },
    ]));
    const r = await fetchLyrics({ query: 'queen bohemian rhapsody' });
    assert.equal(r?.lyrics, 'found');
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.match(String(fetchMock.mock.calls[0].arguments[0]), /\/api\/search\?/);
  });

  it('falls back to lyrics.ovh when LRCLIB has nothing', async () => {
    responses.push(
      async () => jsonResponse({}, 404),
      async () => jsonResponse([]),
      async () => jsonResponse({ lyrics: 'ovh lyrics' }),
    );
    const r = await fetchLyrics({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    assert.deepEqual(
      { lyrics: r?.lyrics, source: r?.source },
      { lyrics: 'ovh lyrics', source: 'lyrics.ovh' },
    );
    assert.match(String(fetchMock.mock.calls[2].arguments[0]), /api\.lyrics\.ovh\/v1\//);
  });

  it('returns null when every source fails or is empty', async () => {
    responses.push(
      async () => { throw new Error('network down'); },
      async () => { throw new Error('network down'); },
      async () => jsonResponse({ error: 'No lyrics found' }, 404),
    );
    const r = await fetchLyrics({ artist: 'Nobody', title: 'Nothing' });
    assert.equal(r, null);
  });

  it('reports LRCLIB instrumentals explicitly', async () => {
    responses.push(async () => jsonResponse({
      artistName: 'Vangelis', trackName: 'Chariots of Fire',
      plainLyrics: null, instrumental: true,
    }));
    const r = await fetchLyrics({ artist: 'Vangelis', title: 'Chariots of Fire' });
    assert.deepEqual(
      { instrumental: r?.instrumental, lyrics: r?.lyrics },
      { instrumental: true, lyrics: '' },
    );
  });

  it('never calls lyrics.ovh without both artist and title', async () => {
    responses.push(async () => jsonResponse([]));
    const r = await fetchLyrics({ query: 'unknown song' });
    assert.equal(r, null);
    assert.equal(fetchMock.mock.callCount(), 1);
  });
});
