import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  belowRealtimeWarning,
  classifyEncoderExit,
  describeDuration,
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
    assert.match(c.detail, /403/);
  });
  it('a live source ending is never "reached its end"', () => {
    assert.equal(classifyEncoderExit({ mode: 'live', loop: false, exitError: null }).reason, 'source_unreachable');
  });
  it('other failures are encoder failures', () => {
    const c = classifyEncoderExit({ mode: 'file', loop: true, exitError: 'Error initializing output stream 0:0' });
    assert.equal(c.reason, 'encoder_failure');
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
