import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  encoderLabel,
  formatClock,
  formatTimeout,
  lastStopLabel,
  qualityLabel,
} from '../../src/lib/video-streaming';

describe('video streaming labels', () => {
  it('formats countdowns and uptime', () => {
    assert.equal(formatClock(299_001), '5:00');
    assert.equal(formatClock(59_000), '0:59');
    assert.equal(formatClock(3_723_000), '1:02:03');
    assert.equal(formatClock(-5), '0:00');
  });

  it('formats timeouts', () => {
    assert.equal(formatTimeout(0), 'Off');
    assert.equal(formatTimeout(45), '45 s');
    assert.equal(formatTimeout(300), '5 min');
    assert.equal(formatTimeout(5400), '1 h 30 min');
  });

  it('shows requested → actual quality', () => {
    const base = { width: 1920, height: 1080, sourceWidth: 1920, sourceHeight: 1080, note: null };
    assert.equal(qualityLabel({ ...base, requested: 'auto', actual: '1080p' }), 'Auto → 1080p');
    assert.equal(qualityLabel({ ...base, requested: '1440p', actual: '1440p' }), '1440p');
    assert.equal(qualityLabel(null, '720p'), '720p');
  });

  it('makes encoder fallbacks visible', () => {
    const base = { codec: 'h264' as const, hardware: false, fallbackReason: 'Device creation failed', note: null };
    assert.equal(
      encoderLabel({ ...base, requested: 'h264_vaapi', selected: 'h264_vaapi', active: 'h264' }),
      'H.264 (VAAPI) → H.264 (software)',
    );
    assert.equal(
      encoderLabel({ ...base, codec: 'vp8', requested: 'auto', selected: 'vp8', active: 'vp8' }),
      'Auto → VP8 (software)',
    );
  });

  it('describes the last stop truthfully', () => {
    const now = 10_000_000;
    assert.equal(
      lastStopLabel({ reason: 'no_viewers', at: now - 8 * 60_000, detail: 'Stopped after 5 minutes with no viewers' }, now),
      'Stopped after 5 minutes with no viewers · 8 min ago',
    );
    assert.equal(lastStopLabel({ reason: 'manual', at: now, detail: null }, now), 'Stopped manually · just now');
    assert.equal(lastStopLabel(null, now), null);
  });
});
