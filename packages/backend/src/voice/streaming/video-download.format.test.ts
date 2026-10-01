import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { YOUTUBE_VIDEO_FORMAT_SORT, youtubeVideoFormatArgs } from './video-download.js';

describe('youtubeVideoFormatArgs', () => {
  it('caps every preferred format at the requested height', () => {
    const [flag, filter] = youtubeVideoFormatArgs(1080);
    assert.equal(flag, '-f');
    for (const choice of filter.split('/').slice(0, -1)) {
      assert.match(choice, /\[height<=1080\]/);
    }
  });

  it('keeps a bare last-resort fallback so a stream still starts', () => {
    // Intentional: without it, a video whose formats all miss the height
    // filter fails to start instead of being scaled down by the sidecar.
    const [, filter] = youtubeVideoFormatArgs(1080);
    assert.equal(filter.split('/').at(-1), 'b');
  });

  it('prefers SDR but falls back when no SDR format exists', () => {
    const [, filter] = youtubeVideoFormatArgs(720);
    const choices = filter.split('/');
    assert.equal(choices[0], 'bv*[height<=720][dynamic_range=SDR]+ba');
    assert.equal(choices[1], 'bv*[height<=720]+ba');
    assert.equal(choices.at(-1), 'b');
  });

  it('sorts VP9 ahead of AV1 without outranking resolution or frame rate', () => {
    const args = youtubeVideoFormatArgs(2160);
    assert.deepEqual(args.slice(2), ['-S', YOUTUBE_VIDEO_FORMAT_SORT]);
    assert.deepEqual(YOUTUBE_VIDEO_FORMAT_SORT.split(','), ['res', 'fps', 'vcodec:vp9']);
  });
});
