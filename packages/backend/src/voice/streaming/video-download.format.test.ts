import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  YOUTUBE_VIDEO_FORMAT_SORT,
  durationFilterSkipMessage,
  youtubeVideoFormatArgs,
} from './video-download.js';

describe('youtubeVideoFormatArgs', () => {
  it('caps every preferred format at the requested height', () => {
    const [flag, filter] = youtubeVideoFormatArgs(1080);
    assert.equal(flag, '-f');
    for (const choice of filter.split('/').slice(0, -2)) {
      assert.match(choice, /\[height<=1080\]/);
    }
  });

  it('keeps unrestricted last-resort fallbacks so a stream still starts', () => {
    // Intentional: without them, a video whose formats all miss the height
    // filter fails to start instead of being scaled down by the sidecar.
    // `bv*+ba` merges separate video/audio; a bare `b` only takes a combined one.
    const [, filter] = youtubeVideoFormatArgs(1080);
    assert.deepEqual(filter.split('/').slice(-2), ['bv*+ba', 'b']);
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

describe('durationFilterSkipMessage', () => {
  // What yt-dlp 2026.08.19 prints, with exit code 0, for a 45-minute video
  // against the default 900 s limit.
  const skipped =
    '[youtube] YyZq_lEJZ2U: Downloading webpage\n' +
    '[download] Audio Sync Test (60fps) - 45min for Longer Tests does not pass filter (duration <= 900), skipping ..\n';

  it('names the limit and where to change it when the duration filter skipped the video', () => {
    const msg = durationFilterSkipMessage(skipped, 900);
    assert.equal(
      msg,
      'Video is longer than the 15 minutes limit, or is a live broadcast (not supported). ' +
        'Raise "Max video duration" under Settings → YouTube (0 = unlimited).',
    );
  });

  it('blames the missing length when there is no limit (a live stream)', () => {
    const live = '[download] Some stream does not pass filter (duration >= 0), skipping ..\n';
    const msg = durationFilterSkipMessage(live, 0);
    assert.ok(msg);
    assert.match(msg, /no known length/);
  });

  it('says nothing for a normal download or another filter', () => {
    assert.equal(durationFilterSkipMessage('[download] Destination: /data/music/.stream-1.mp4\n', 900), null);
    assert.equal(durationFilterSkipMessage('[download] X does not pass filter (!is_live), skipping ..\n', 900), null);
    assert.equal(durationFilterSkipMessage('', 900), null);
  });
});
