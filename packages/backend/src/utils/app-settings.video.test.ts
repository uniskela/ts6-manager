import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VIDEO_AUTO_MAX_PRESET_KEY,
  VIDEO_ANNOUNCE_AUTO_STOPS_KEY,
  VIDEO_CPU_USED_KEY,
  VIDEO_DEFAULT_ENCODER_KEY,
  VIDEO_ENCODE_PROFILE_KEY,
  VIDEO_MAX_BITRATE_KEY,
  VIDEO_NO_VIEWER_TIMEOUT_KEY,
  VIDEO_PREFER_HARDWARE_KEY,
  loadServerVideoStreamingSettings,
  loadVideoStreamingSettings,
  parseServerOverrides,
  parseVideoStreamingSettings,
  parseVideoStreamingUpdate,
  videoServerOverridesKey,
  videoStreamingDefaults,
} from './app-settings.js';

describe('video streaming settings', () => {
  it('defaults to Balanced profile (1080p, 4500k, cpu-used 4) and 5 min no-viewer stop', () => {
    assert.deepEqual(videoStreamingDefaults({}), {
      noViewerTimeoutSec: 300,
      announceAutoStops: true,
      autoMaxPreset: '1080p',
      defaultEncoder: 'auto',
      preferHardware: false,
      maxBitrateKbps: 4500,
      encodeProfile: 'balanced',
      cpuUsed: 4,
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
        VIDEO_CPU_USED: '6',
        VIDEO_ENCODE_PROFILE: 'custom',
      }),
      {
        noViewerTimeoutSec: 0,
        announceAutoStops: true,
        autoMaxPreset: '2160p',
        defaultEncoder: 'h264_vaapi',
        preferHardware: true,
        maxBitrateKbps: 12000,
        encodeProfile: 'custom',
        cpuUsed: 6,
      },
    );
    const bad = videoStreamingDefaults({ VIDEO_NO_VIEWER_TIMEOUT_SECONDS: '-1', VIDEO_AUTO_MAX_PRESET: '8k', VIDEO_ENCODER: 'nvenc' });
    assert.equal(bad.noViewerTimeoutSec, 300);
    assert.equal(bad.autoMaxPreset, '1080p');
    assert.equal(bad.defaultEncoder, 'auto');
    assert.equal(bad.encodeProfile, 'balanced');
  });

  it('stored values override env defaults', () => {
    const settings = parseVideoStreamingSettings(
      new Map([
        [VIDEO_NO_VIEWER_TIMEOUT_KEY, '600'],
        [VIDEO_ANNOUNCE_AUTO_STOPS_KEY, 'false'],
        [VIDEO_AUTO_MAX_PRESET_KEY, '1440p'],
        [VIDEO_DEFAULT_ENCODER_KEY, 'vp9'],
        [VIDEO_PREFER_HARDWARE_KEY, 'true'],
        [VIDEO_MAX_BITRATE_KEY, '0'],
        [VIDEO_CPU_USED_KEY, '2'],
        [VIDEO_ENCODE_PROFILE_KEY, 'quality'],
      ]),
      videoStreamingDefaults({ VIDEO_MAX_BITRATE_KBPS: '9000' }),
    );
    assert.deepEqual(settings, {
      noViewerTimeoutSec: 600,
      announceAutoStops: false,
      autoMaxPreset: '1440p',
      defaultEncoder: 'vp9',
      preferHardware: true,
      maxBitrateKbps: 0,
      encodeProfile: 'quality',
      cpuUsed: 2,
    });
  });

  it('accepts AMF in env defaults, stored settings, updates and server overrides', () => {
    assert.equal(videoStreamingDefaults({ VIDEO_ENCODER: 'h264_amf' }).defaultEncoder, 'h264_amf');
    assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_DEFAULT_ENCODER_KEY, 'h264_amf']])).defaultEncoder, 'h264_amf');
    const update = parseVideoStreamingUpdate({ defaultEncoder: 'h264_amf' });
    assert.ok(update.ok);
    assert.equal(update.rows.find((r) => r.key === VIDEO_DEFAULT_ENCODER_KEY)?.value, 'h264_amf');
    assert.equal(parseServerOverrides({ defaultEncoder: 'h264_amf' }).defaultEncoder, 'h264_amf');
  });

  it('marks custom when Advanced knobs diverge from a named profile', () => {
    const settings = parseVideoStreamingSettings(
      new Map([
        [VIDEO_ENCODE_PROFILE_KEY, 'performance'],
        [VIDEO_AUTO_MAX_PRESET_KEY, '720p'],
        [VIDEO_MAX_BITRATE_KEY, '999'],
        [VIDEO_CPU_USED_KEY, '6'],
      ]),
    );
    assert.equal(settings.encodeProfile, 'custom');
  });

  it('expands a named encodeProfile on update', () => {
    const ok = parseVideoStreamingUpdate({ encodeProfile: 'performance' });
    assert.ok(ok.ok);
    assert.deepEqual(
      Object.fromEntries(ok.rows.map((r) => [r.key, r.value])),
      {
        [VIDEO_ENCODE_PROFILE_KEY]: 'performance',
        [VIDEO_AUTO_MAX_PRESET_KEY]: '720p',
        [VIDEO_MAX_BITRATE_KEY]: '2500',
        [VIDEO_CPU_USED_KEY]: '6',
      },
    );
  });

  it('validates updates field by field', () => {
    const ok = parseVideoStreamingUpdate({ noViewerTimeoutSec: 0, announceAutoStops: false, autoMaxPreset: '2160p', preferHardware: false });
    assert.ok(ok.ok);
    const map = Object.fromEntries(ok.rows.map((r) => [r.key, r.value]));
    assert.equal(map[VIDEO_NO_VIEWER_TIMEOUT_KEY], '0');
    assert.equal(map[VIDEO_ANNOUNCE_AUTO_STOPS_KEY], 'false');
    assert.equal(map[VIDEO_AUTO_MAX_PRESET_KEY], '2160p');
    assert.equal(map[VIDEO_PREFER_HARDWARE_KEY], 'false');
    assert.equal(map[VIDEO_ENCODE_PROFILE_KEY], 'custom');
    for (const body of [
      {},
      { noViewerTimeoutSec: 90_000 },
      { announceAutoStops: 'yes' },
      { autoMaxPreset: '4320p' },
      { defaultEncoder: 'nvenc' },
      { preferHardware: 'yes' },
      { maxBitrateKbps: 1.5 },
      { encodeProfile: 'turbo' },
      { cpuUsed: 99 },
    ]) {
      assert.equal(parseVideoStreamingUpdate(body).ok, false, JSON.stringify(body));
    }
  });
});

describe('per-server video defaults', () => {
  function prismaWith(rows: Record<string, string>) {
    return {
      appSetting: {
        findMany: async ({ where }: any) => Object.entries(rows)
          .filter(([key]) => where.key.in.includes(key))
          .map(([key, value]) => ({ key, value })),
      },
    } as any;
  }

  it('drops invalid override fields', () => {
    assert.deepEqual(
      parseServerOverrides('{"autoMaxPreset":"2160p","defaultEncoder":"nvenc","noViewerTimeoutSec":60,"junk":1}'),
      { autoMaxPreset: '2160p', noViewerTimeoutSec: 60, encodeProfile: 'custom' },
    );
    assert.deepEqual(parseServerOverrides('not json'), {});
  });

  it('stores normalized numbers and bools from stringy override input', () => {
    assert.deepEqual(
      parseServerOverrides('{"noViewerTimeoutSec":"60","maxBitrateKbps":"0","preferHardware":true}'),
      { noViewerTimeoutSec: 60, maxBitrateKbps: 0, preferHardware: true, encodeProfile: 'custom' },
    );
  });

  it('parses the per-server announcement switch', () => {
    assert.deepEqual(
      parseServerOverrides('{"announceAutoStops":false}'),
      { announceAutoStops: false },
    );
  });

  it('preserves a named encodeProfile when the override matches that profile', () => {
    assert.deepEqual(
      parseServerOverrides(
        '{"encodeProfile":"performance","autoMaxPreset":"720p","maxBitrateKbps":2500,"cpuUsed":6}',
      ),
      { encodeProfile: 'performance', autoMaxPreset: '720p', maxBitrateKbps: 2500, cpuUsed: 6 },
    );
  });

  it('merges a server\'s overrides over the global defaults', async () => {
    const prisma = prismaWith({
      [VIDEO_NO_VIEWER_TIMEOUT_KEY]: '600',
      [videoServerOverridesKey(2)]: '{"autoMaxPreset":"2160p","preferHardware":true}',
    });
    const s2 = await loadVideoStreamingSettings(prisma, 2);
    assert.equal(s2.noViewerTimeoutSec, 600, 'inherits global');
    assert.equal(s2.autoMaxPreset, '2160p');
    assert.equal(s2.preferHardware, true);
    const s3 = await loadVideoStreamingSettings(prisma, 3);
    assert.equal(s3.autoMaxPreset, videoStreamingDefaults().autoMaxPreset, 'other servers unaffected');

    const detail = await loadServerVideoStreamingSettings(prisma, 2);
    assert.equal(detail.overrides.autoMaxPreset, '2160p');
    assert.equal(detail.overrides.preferHardware, true);
    assert.equal(detail.global.noViewerTimeoutSec, 600);
    assert.equal(detail.effective.autoMaxPreset, '2160p');
  });
});
