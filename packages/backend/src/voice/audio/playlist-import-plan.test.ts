import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planImport, youtubeWatchUrl, isYouTubePlaylistUrl, type PlanEntry } from './playlist-import-plan.js';

const e = (id: string): PlanEntry => ({ id, title: `Track ${id}`, url: youtubeWatchUrl(id) });

describe('youtubeWatchUrl', () => {
  it('builds a canonical watch url', () => {
    assert.equal(youtubeWatchUrl('abc'), 'https://www.youtube.com/watch?v=abc');
  });
});

describe('isYouTubePlaylistUrl', () => {
  it('accepts a bare playlist url', () => {
    assert.equal(isYouTubePlaylistUrl('https://www.youtube.com/playlist?list=PL123'), true);
    assert.equal(isYouTubePlaylistUrl('https://youtube.com/playlist?list=PL123'), true);
    assert.equal(isYouTubePlaylistUrl('https://music.youtube.com/playlist?list=PL123'), true);
    assert.equal(isYouTubePlaylistUrl('https://m.youtube.com/playlist?list=PL123'), true);
  });

  it('rejects a video opened from a playlist', () => {
    assert.equal(isYouTubePlaylistUrl('https://www.youtube.com/watch?v=abc&list=PL123'), false);
    assert.equal(isYouTubePlaylistUrl('https://www.youtube.com/watch?v=abc&list=PL123&index=4'), false);
  });

  it('rejects an autoplay/Mix link', () => {
    assert.equal(isYouTubePlaylistUrl('https://www.youtube.com/watch?v=abc&list=RDabc&start_radio=1'), false);
  });

  it('rejects a plain video url', () => {
    assert.equal(isYouTubePlaylistUrl('https://www.youtube.com/watch?v=abc'), false);
    assert.equal(isYouTubePlaylistUrl('https://youtu.be/abc'), false);
  });

  it('rejects a list= parameter on an unrelated host', () => {
    assert.equal(isYouTubePlaylistUrl('https://example.com/playlist?list=PL123'), false);
    assert.equal(isYouTubePlaylistUrl('https://youtube.com.evil.test/playlist?list=PL123'), false);
  });

  it('rejects a malformed url instead of throwing', () => {
    assert.equal(isYouTubePlaylistUrl('not a url at all'), false);
    assert.equal(isYouTubePlaylistUrl(''), false);
  });

  it('ignores a youtu.be short link even with a list', () => {
    assert.equal(isYouTubePlaylistUrl('https://youtu.be/abc?list=PL123'), false);
  });
});

describe('planImport', () => {
  it('returns everything empty for an empty playlist', () => {
    const plan = planImport([], new Set(), 50);
    assert.deepEqual(plan.toImport, []);
    assert.deepEqual(plan.alreadyPresent, []);
    assert.equal(plan.truncated, 0);
  });

  it('imports every entry when under the cap', () => {
    const plan = planImport([e('a'), e('b')], new Set(), 50);
    assert.deepEqual(plan.toImport.map((x) => x.id), ['a', 'b']);
    assert.equal(plan.truncated, 0);
  });

  it('caps the import and reports how many were cut', () => {
    const plan = planImport([e('a'), e('b'), e('c')], new Set(), 2);
    assert.deepEqual(plan.toImport.map((x) => x.id), ['a', 'b']);
    assert.equal(plan.truncated, 1);
  });

  it('skips entries already attached to this playlist', () => {
    const plan = planImport([e('a'), e('b')], new Set([youtubeWatchUrl('a')]), 50);
    assert.deepEqual(plan.toImport.map((x) => x.id), ['b']);
    assert.deepEqual(plan.alreadyPresent.map((x) => x.id), ['a']);
    assert.equal(plan.truncated, 0);
  });

  it('does not let already-present entries consume the cap', () => {
    const entries = [e('a'), e('b'), e('c'), e('d')];
    const attached = new Set([youtubeWatchUrl('a'), youtubeWatchUrl('b'), youtubeWatchUrl('c')]);
    const plan = planImport(entries, attached, 2);
    assert.deepEqual(plan.toImport.map((x) => x.id), ['d']);
    assert.equal(plan.alreadyPresent.length, 3);
    assert.equal(plan.truncated, 0);
  });

  it('treats a cap of zero as importing nothing', () => {
    const plan = planImport([e('a'), e('b')], new Set(), 0);
    assert.deepEqual(plan.toImport, []);
    assert.equal(plan.truncated, 2);
  });

  it('drops entries with no id', () => {
    const plan = planImport([{ id: '', title: 'broken', url: '' }, e('a')], new Set(), 50);
    assert.deepEqual(plan.toImport.map((x) => x.id), ['a']);
  });
});
