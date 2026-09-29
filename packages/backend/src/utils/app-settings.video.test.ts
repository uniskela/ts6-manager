import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VIDEO_AUTO_MAX_PRESET_KEY,
  VIDEO_DEFAULT_ENCODER_KEY,
  VIDEO_MAX_BITRATE_KEY,
  VIDEO_NO_VIEWER_TIMEOUT_KEY,
  VIDEO_PREFER_HARDWARE_KEY,
  parseVideoStreamingSettings,
  parseVideoStreamingUpdate,
  videoStreamingDefaults,
} from './app-settings.js';

describe('video streaming settings', () => {
  it('defaults to a 5 minute no-viewer stop, Auto up to 1080p, software encode', () => {
    assert.deepEqual(videoStreamingDefaults({}), {
      noViewerTimeoutSec: 300,
      autoMaxPreset: '1080p',
      defaultEncoder: 'auto',
      preferHardware: false,
      maxBitrateKbps: 0,
    });
  });

  it('reads env defaults and ignores invalid ones', () => {
    assert.deepEqual(
      videoStreamingDefaults({
        VIDEO_NO_VIEWER_TIMEOUT_SECONDS: '0',
        VIDEO_AUTO_MAX_PRESET: '2160p',
        VIDEO_ENCODER: 'h264_vaapi',
        VIDEO_PREFER_HARDWARE: 'true',
        VIDEO_MAX_BITRATE_KBPS: '12000',
      }),
      { noViewerTimeoutSec: 0, autoMaxPreset: '2160p', defaultEncoder: 'h264_vaapi', preferHardware: true, maxBitrateKbps: 12000 },
    );
    const bad = videoStreamingDefaults({ VIDEO_NO_VIEWER_TIMEOUT_SECONDS: '-1', VIDEO_AUTO_MAX_PRESET: '8k', VIDEO_ENCODER: 'nvenc' });
    assert.equal(bad.noViewerTimeoutSec, 300);
    assert.equal(bad.autoMaxPreset, '1080p');
    assert.equal(bad.defaultEncoder, 'auto');
  });

  it('stored values override env defaults', () => {
    const settings = parseVideoStreamingSettings(
      new Map([
        [VIDEO_NO_VIEWER_TIMEOUT_KEY, '600'],
        [VIDEO_AUTO_MAX_PRESET_KEY, '1440p'],
        [VIDEO_DEFAULT_ENCODER_KEY, 'vp9'],
        [VIDEO_PREFER_HARDWARE_KEY, 'true'],
        [VIDEO_MAX_BITRATE_KEY, 'junk'],
      ]),
      videoStreamingDefaults({ VIDEO_MAX_BITRATE_KBPS: '9000' }),
    );
    assert.deepEqual(settings, {
      noViewerTimeoutSec: 600,
      autoMaxPreset: '1440p',
      defaultEncoder: 'vp9',
      preferHardware: true,
      maxBitrateKbps: 9000,
    });
  });

  it('validates updates field by field', () => {
    const ok = parseVideoStreamingUpdate({ noViewerTimeoutSec: 0, autoMaxPreset: '2160p', preferHardware: false });
    assert.ok(ok.ok);
    assert.deepEqual(ok.rows, [
      { key: VIDEO_NO_VIEWER_TIMEOUT_KEY, value: '0' },
      { key: VIDEO_AUTO_MAX_PRESET_KEY, value: '2160p' },
      { key: VIDEO_PREFER_HARDWARE_KEY, value: 'false' },
    ]);
    for (const body of [
      {},
      { noViewerTimeoutSec: 90_000 },
      { autoMaxPreset: '4320p' },
      { defaultEncoder: 'nvenc' },
      { preferHardware: 'yes' },
      { maxBitrateKbps: 1.5 },
    ]) {
      assert.equal(parseVideoStreamingUpdate(body).ok, false, JSON.stringify(body));
    }
  });
});
