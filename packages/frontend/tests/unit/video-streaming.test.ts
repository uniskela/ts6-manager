import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENCODER_OPTIONS,
  autoEncoderPreferenceHint,
  autoEncoderPreferenceLabel,
  encoderLabel,
  formatClock,
  formatTimeout,
  lastStopLabel,
  qualityAdaptationNote,
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

  it('shows when Auto is below the quality it started at, and why', () => {
    const base = { width: 1280, height: 720, sourceWidth: 1920, sourceHeight: 1080, note: null };
    const down = {
      direction: 'down' as const, from: '1080p' as const, to: '720p' as const, at: 1_000_000,
      reason: 'Encoding stayed below realtime (0.62x for 30 s) at 1080p',
    };
    const reduced = {
      ...base, requested: 'auto' as const, actual: '720p' as const,
      adaptation: { ceiling: '1080p' as const, lastChange: down, changes: 1 },
    };
    assert.equal(qualityLabel(reduced), 'Auto → 720p (reduced from 1080p)');
    assert.deepEqual(qualityAdaptationNote(reduced, 1_000_000 + 3 * 60_000), {
      text: 'Auto reduced quality to 720p: Encoding stayed below realtime (0.62x for 30 s) at 1080p · 3 min ago',
      reduced: true,
    });
    // Still explained hours later while the stream stays reduced.
    assert.equal(qualityAdaptationNote(reduced, 1_000_000 + 5 * 3_600_000)?.reduced, true);

    const up = { direction: 'up' as const, from: '720p' as const, to: '1080p' as const, at: 2_000_000, reason: 'Encoding held realtime for 2 minutes at 720p' };
    const restored = {
      ...base, requested: 'auto' as const, actual: '1080p' as const,
      adaptation: { ceiling: '1080p' as const, lastChange: up, changes: 2 },
    };
    assert.equal(qualityLabel(restored), 'Auto → 1080p');
    assert.deepEqual(qualityAdaptationNote(restored, 2_000_000), {
      text: 'Auto raised quality to 1080p: Encoding held realtime for 2 minutes at 720p · just now',
      reduced: false,
    });
    assert.equal(qualityAdaptationNote(restored, 2_000_000 + 11 * 60_000), null, 'a full recovery is not shown for ever');

    const untouched = { ...base, requested: 'auto' as const, actual: '1080p' as const, adaptation: { ceiling: '1080p' as const, lastChange: null, changes: 0 } };
    assert.equal(qualityAdaptationNote(untouched), null);
    assert.equal(qualityAdaptationNote({ ...base, requested: '720p', actual: '720p', adaptation: null }), null);
    assert.equal(qualityAdaptationNote(null), null);
  });

  it('makes encoder fallbacks visible', () => {
    const base = { codec: 'h264' as const, hardware: false, fallbackReason: 'Device creation failed', note: null };
    assert.equal(
      encoderLabel({ ...base, requested: 'h264_vaapi', selected: 'h264_vaapi', active: 'h264' }),
      'H.264 (VAAPI) → H.264 (software)',
    );
    assert.equal(
      encoderLabel({ ...base, requested: 'h264_nvenc', selected: 'h264_nvenc', active: 'h264' }),
      'H.264 (NVENC) → H.264 (software)',
    );
    assert.equal(
      encoderLabel({ ...base, hardware: true, fallbackReason: null, requested: 'h264_nvenc', selected: 'h264_nvenc', active: 'h264_nvenc' }),
      'H.264 (NVENC)',
    );
    assert.equal(
      encoderLabel({ ...base, requested: 'h264_amf', selected: 'h264_amf', active: 'h264' }),
      'H.264 (AMF) → H.264 (software)',
    );
    assert.equal(
      encoderLabel({ ...base, hardware: true, fallbackReason: null, requested: 'h264_amf', selected: 'h264_amf', active: 'h264_amf' }),
      'H.264 (AMF)',
    );
    assert.equal(
      encoderLabel({ ...base, hardware: true, fallbackReason: null, requested: 'auto', selected: 'h264_amf', active: 'h264_amf' }),
      'Auto → H.264 (AMF)',
    );
    assert.equal(
      encoderLabel({ ...base, codec: 'vp8', requested: 'auto', selected: 'vp8', active: 'vp8' }),
      'Auto → VP8 (software)',
    );
  });

  it('offers AMF in encoder selections', () => {
    assert.deepEqual(ENCODER_OPTIONS.find((o) => o.value === 'h264_amf'), { value: 'h264_amf', label: 'H.264 (AMF)' });
    assert.deepEqual(ENCODER_OPTIONS.find((o) => o.value === 'h264_videotoolbox'), {
      value: 'h264_videotoolbox',
      label: 'H.264 (VideoToolbox)',
    });
    assert.equal(
      encoderLabel({
        codec: 'h264', hardware: false, fallbackReason: 'cannot create compression session', note: null,
        requested: 'h264_videotoolbox', selected: 'h264_videotoolbox', active: 'h264',
      }),
      'H.264 (VideoToolbox) → H.264 (software)',
    );
    assert.match(autoEncoderPreferenceHint(true), /VideoToolbox/);
  });

  it('labels Auto by whether hardware preference is on', () => {
    assert.equal(autoEncoderPreferenceLabel(false), 'Auto (software preferred)');
    assert.equal(autoEncoderPreferenceLabel(true), 'Auto (hardware preferred)');
    assert.match(autoEncoderPreferenceHint(false), /VP8 software/);
    assert.match(autoEncoderPreferenceHint(false), /Streaming defaults/);
    assert.match(autoEncoderPreferenceHint(true), /hardware encoder/);
    assert.match(autoEncoderPreferenceHint(true), /Per-stream Auto/);
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
