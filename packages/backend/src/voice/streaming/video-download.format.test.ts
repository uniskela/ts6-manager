import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  YOUTUBE_VIDEO_FORMAT_SORT,
  durationFilterSkipMessage,
  parseYoutubeResolve,
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
      'Video is longer than the 15 minutes limit, or is a live broadcast. ' +
        'Under Settings → YouTube, turn on "Stream YouTube videos directly" (no length limit, live broadcasts work) ' +
        'or raise "Max video duration" (0 = unlimited).',
    );
  });

  it('blames the missing length when there is no limit (a live stream)', () => {
    const live = '[download] Some stream does not pass filter (duration >= 0), skipping ..\n';
    const msg = durationFilterSkipMessage(live, 0);
    assert.ok(msg);
    assert.match(msg, /no known length/);
    assert.match(msg, /Stream YouTube videos directly/);
  });

  it('says nothing for a normal download or another filter', () => {
    assert.equal(durationFilterSkipMessage('[download] Destination: /data/music/.stream-1.mp4\n', 900), null);
    assert.equal(durationFilterSkipMessage('[download] X does not pass filter (!is_live), skipping ..\n', 900), null);
    assert.equal(durationFilterSkipMessage('', 900), null);
  });
});

describe('parseYoutubeResolve', () => {
  // The shape of yt-dlp --dump-single-json for a format pair: the chosen
  // video and audio formats are listed under requested_formats.
  const pair = {
    duration: 2700,
    is_live: false,
    width: 3840,
    height: 2160,
    requested_formats: [
      { format_id: '313', vcodec: 'vp09.00.51.08', acodec: 'none', width: 3840, height: 2160, url: 'https://rr1.example/videoplayback?v' },
      { format_id: '251', vcodec: 'none', acodec: 'opus', url: 'https://rr1.example/videoplayback?a' },
    ],
  };

  it('returns the video and the audio of a format pair as two inputs', () => {
    assert.deepEqual(parseYoutubeResolve(pair), {
      path: 'https://rr1.example/videoplayback?v',
      audioPath: 'https://rr1.example/videoplayback?a',
      durationSec: 2700,
      live: false,
      resolution: { width: 3840, height: 2160 },
    });
  });

  it('finds the video whichever order the pair is listed in', () => {
    const r = parseYoutubeResolve({ ...pair, requested_formats: [...pair.requested_formats].reverse() });
    assert.equal(r.path, 'https://rr1.example/videoplayback?v');
    assert.equal(r.audioPath, 'https://rr1.example/videoplayback?a');
  });

  it('returns a combined live format as one input with no duration', () => {
    const r = parseYoutubeResolve({
      is_live: true,
      duration: 0,
      width: 1920,
      height: 1080,
      url: 'https://manifest.example/hls/index.m3u8',
    });
    assert.deepEqual(r, {
      path: 'https://manifest.example/hls/index.m3u8',
      durationSec: null,
      live: true,
      resolution: { width: 1920, height: 1080 },
    });
  });

  it('keeps a live broadcast that comes as two playlists as two inputs', () => {
    const r = parseYoutubeResolve({ ...pair, is_live: true, duration: undefined });
    assert.equal(r.live, true);
    assert.equal(r.durationSec, null);
    assert.equal(r.audioPath, 'https://rr1.example/videoplayback?a');
  });

  it('treats live_status as live and leaves the size out when it is unknown', () => {
    const r = parseYoutubeResolve({ live_status: 'is_live', url: 'https://manifest.example/x.m3u8' });
    assert.equal(r.live, true);
    assert.equal(r.resolution, undefined);
    assert.equal(r.audioPath, undefined);
  });

  it('refuses a result without an http(s) media URL', () => {
    assert.throws(() => parseYoutubeResolve({ duration: 10 }), /playable YouTube stream URL/);
    assert.throws(() => parseYoutubeResolve({ url: 'file:///etc/passwd' }), /playable YouTube stream URL/);
    assert.throws(
      () => parseYoutubeResolve({ requested_formats: [{ vcodec: 'vp9', acodec: 'none', url: 'ftp://x/v' }] }),
      /playable YouTube stream URL/,
    );
  });
});
