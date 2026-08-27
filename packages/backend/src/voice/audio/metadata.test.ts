import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  looksLikeYouTubeIdTitle,
  youtubeIdFromFilename,
} from './metadata.js';

describe('youtubeIdFromFilename', () => {
  it('detects yt-dlp %(id)s filenames for common extract extensions', () => {
    assert.equal(youtubeIdFromFilename('vk_O3yhLbMA.opus'), 'vk_O3yhLbMA');
    assert.equal(youtubeIdFromFilename('dQw4w9WgXcQ.mp3'), 'dQw4w9WgXcQ');
  });

  it('rejects normal titles and non-media-ish names', () => {
    assert.equal(youtubeIdFromFilename('Artist - Song.mp3'), null);
    assert.equal(youtubeIdFromFilename('short.opus'), null);
    assert.equal(youtubeIdFromFilename('vk_O3yhLbMA.flac'), null);
  });
});

describe('looksLikeYouTubeIdTitle', () => {
  it('matches bare ids', () => {
    assert.equal(looksLikeYouTubeIdTitle('vk_O3yhLbMA'), true);
    assert.equal(looksLikeYouTubeIdTitle('Hello World'), false);
  });
});
