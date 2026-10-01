import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  belowRealtimeWarning,
  classifyEncoderExit,
  describeDuration,
  isChannelEmptyForAutoStop,
  parseAutoStopEmptySeconds,
  resolveSourceMode,
} from './lifecycle.js';

describe('source mode', () => {
  it('local files are always file mode', () => {
    assert.equal(resolveSourceMode('live', true, null), 'file');
  });
  it('explicit live/vod wins for remote sources', () => {
    assert.equal(resolveSourceMode('live', false, { durationSec: 120 }), 'live');
    assert.equal(resolveSourceMode('vod', false, { durationSec: null }), 'vod');
  });
  it('auto uses the probe duration, never the URL', () => {
    assert.equal(resolveSourceMode('auto', false, { durationSec: null }), 'live');
    assert.equal(resolveSourceMode('auto', false, { durationSec: 3600 }), 'vod');
    // No probe (fixed presets): keep pre-1.9 VOD behaviour.
    assert.equal(resolveSourceMode(undefined, false, null), 'vod');
  });
  it('extractor live hint (Twitch) maps fixed-preset remote to live', () => {
    // Same shape applyVideoSource builds when resolved.live === true.
    assert.equal(resolveSourceMode('auto', false, { durationSec: null }), 'live');
  });
});

describe('encoder exit classification', () => {
  it('a clean end of a non-looping VOD/file is the source ending', () => {
    assert.deepEqual(classifyEncoderExit({ mode: 'vod', loop: false, exitError: null }), {
      reason: 'source_ended', detail: 'Video reached its end',
    });
  });
  it('network and HTTP errors mean the source is unreachable', () => {
    const c = classifyEncoderExit({ mode: 'vod', loop: false, exitError: '<source> Server returned 403 Forbidden' });
    assert.equal(c.reason, 'source_unreachable');
    assert.equal(c.detail, 'Source returned 403 Forbidden — access may be blocked');
  });
  it('HTTP 400 and empty HLS maps become short operator wording', () => {
    const bad = classifyEncoderExit({
      mode: 'live',
      loop: false,
      exitError: '[https @ 0x615d916dab80] HTTP error 400 Bad Request; <source> Server returned 400 Bad Request',
    });
    assert.equal(bad.reason, 'source_unreachable');
    assert.equal(bad.detail, 'Source returned 400 Bad Request — URL may be invalid or expired');

    const empty = classifyEncoderExit({
      mode: 'live',
      loop: false,
      exitError: "Stream map '0:v:0' matches no streams.; To ignore this, add a trailing '?' to the map.",
    });
    assert.equal(empty.reason, 'source_unreachable');
    assert.equal(empty.detail, 'Playlist has no playable streams (variants failed or empty)');
  });
  it('a live source ending is never "reached its end"', () => {
    assert.equal(classifyEncoderExit({ mode: 'live', loop: false, exitError: null }).reason, 'source_unreachable');
  });
  it('other failures are encoder failures', () => {
    const c = classifyEncoderExit({ mode: 'file', loop: true, exitError: 'Error initializing output stream 0:0' });
    assert.equal(c.reason, 'encoder_failure');
  });
  it('bare bitrate/resolution numbers are not treated as HTTP failures', () => {
    const c = classifyEncoderExit({
      mode: 'file',
      loop: true,
      exitError: 'Encoder buffer 400 kbps at 1080x720',
    });
    assert.equal(c.reason, 'encoder_failure');
    assert.match(c.detail, /^Encoder stopped:/);
  });
});

describe('wording', () => {
  it('describes durations', () => {
    assert.equal(describeDuration(300), '5 minutes');
    assert.equal(describeDuration(90), '1 minute 30 seconds');
    assert.equal(describeDuration(1), '1 second');
  });
  it('explains below-realtime with context', () => {
    const w = belowRealtimeWarning({
      speed: 0.62, belowSecs: 40.4, preset: '1080p', encoderLabel: 'VP8 (software)', mode: 'live', rtpDrops: 12,
    });
    assert.equal(
      w,
      'Encoding below realtime (0.62x for 40 s, 12 packets dropped) at 1080p with VP8 (software) from a live source. '
        + 'The host cannot keep up — try a lower preset or a hardware encoder.',
    );
  });
});

describe('channel-empty auto-stop (#215)', () => {
  it('a watched video stream is never treated as an empty channel', () => {
    // Tracked peers can miss a viewer; viewers alone keep the stream alive.
    assert.equal(isChannelEmptyForAutoStop(0, true, 1), false);
    assert.equal(isChannelEmptyForAutoStop(0, true, 3), false);
  });
  it('an unwatched stream in an empty channel still counts as empty', () => {
    assert.equal(isChannelEmptyForAutoStop(0, true, 0), true);
  });
  it('audio playback ignores the video viewer count', () => {
    assert.equal(isChannelEmptyForAutoStop(0, false, 2), true);
    assert.equal(isChannelEmptyForAutoStop(1, false, 0), false);
  });
  it('any tracked channel peer means not empty', () => {
    assert.equal(isChannelEmptyForAutoStop(2, true, 0), false);
  });
});

describe('BOT_AUTO_STOP_EMPTY_SECONDS parsing', () => {
  it('defaults to 300 when unset or invalid', () => {
    assert.equal(parseAutoStopEmptySeconds(undefined), 300);
    assert.equal(parseAutoStopEmptySeconds('abc'), 300);
  });
  it('keeps 0 so the stop can be disabled', () => {
    assert.equal(parseAutoStopEmptySeconds('0'), 0);
  });
  it('uses an explicit value', () => {
    assert.equal(parseAutoStopEmptySeconds('600'), 600);
  });
});
