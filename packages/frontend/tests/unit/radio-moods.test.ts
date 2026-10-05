import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { radioMoods, splitGenreTags, stationHasMood } from '../../src/lib/radio-moods.ts';

describe('radio moods', () => {
  it('splits a community-radio tag string into individual tags', () => {
    assert.deepEqual(splitGenreTags('local, local information, local news'), ['local', 'local information', 'local news']);
    assert.deepEqual(splitGenreTags(' Jazz ;  late   night ,, JAZZ '), ['Jazz', 'late night']);
    assert.deepEqual(splitGenreTags('Pop/Rock'), ['Pop/Rock']);
    assert.deepEqual(splitGenreTags(null), []);
    assert.deepEqual(splitGenreTags('  '), []);
  });

  it('counts each station under each of its tags and merges case variants', () => {
    const moods = radioMoods([
      { genre: 'Jazz' },
      { genre: 'jazz, chill' },
      { genre: 'local, local information, local news' },
      { genre: null },
    ]);
    assert.deepEqual(moods, [
      { key: 'jazz', label: 'Jazz', count: 2 },
      { key: 'chill', label: 'Chill', count: 1 },
      { key: 'local', label: 'Local', count: 1 },
      { key: 'local information', label: 'Local Information', count: 1 },
      { key: 'local news', label: 'Local News', count: 1 },
    ]);
  });

  it('keeps deliberate casing in labels', () => {
    assert.deepEqual(radioMoods([{ genre: 'BBC, Pop/Rock' }]).map((m) => m.label), ['BBC', 'Pop/Rock']);
  });

  it('matches a station when any of its tags is the mood', () => {
    assert.equal(stationHasMood('local, Local News', 'local news'), true);
    assert.equal(stationHasMood('local information', 'local'), false);
    assert.equal(stationHasMood(undefined, 'jazz'), false);
  });
});
