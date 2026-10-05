import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VideoEncoderCapabilities, VideoEncoderRequest, VideoStreamSettings } from '@ts6/common';
import {
  VIDEO_DEFAULT_ENCODER_KEY,
  VIDEO_PREFER_HARDWARE_KEY,
  parseVideoStreamingSettings,
  videoStreamingDefaults,
} from '../../utils/app-settings.js';
import { ENCODER_CODEC, encoderDisplayName, isHardwareEncoder, normalizeEncoderRequest, selectEncoder } from './encoders.js';

/** Same resolve path as VoiceBot.startVideoStreamClaimed (options → settings → selectEncoder). */
function resolveStartEncoder(
  optionsEncoder: VideoEncoderRequest | undefined,
  settings: Pick<VideoStreamSettings, 'defaultEncoder' | 'preferHardware'>,
  caps: VideoEncoderCapabilities | null,
) {
  const requested = normalizeEncoderRequest(optionsEncoder, settings.defaultEncoder);
  return selectEncoder(requested, settings.preferHardware, caps);
}

function caps(available: string[], devicePresent = true): VideoEncoderCapabilities {
  const ids = ['vp8', 'vp9', 'h264', 'vp8_vaapi', 'vp9_vaapi', 'h264_vaapi', 'h264_nvenc', 'h264_amf'] as const;
  return {
    checkedAt: new Date(0).toISOString(),
    vaapiDevice: '/dev/dri/renderD128',
    vaapiDevicePresent: devicePresent,
    hwDecode: false,
    encoders: ids.map((id) => ({
      id,
      codec: ENCODER_CODEC[id],
      hardware: isHardwareEncoder(id),
      available: available.includes(id),
    })),
  };
}

describe('selectEncoder', () => {
  it('passes explicit encoders through (the sidecar reports any fallback)', () => {
    assert.deepEqual(selectEncoder('h264_vaapi', false, null), { selected: 'h264_vaapi', note: null });
    assert.deepEqual(selectEncoder('vp9', true, caps([])), { selected: 'vp9', note: null });
  });

  it('keeps auto on software VP8 unless hardware is preferred', () => {
    assert.deepEqual(selectEncoder('auto', false, caps(['h264_vaapi'])), { selected: 'vp8', note: null });
  });

  it('prefers working VAAPI encoders in order', () => {
    assert.equal(selectEncoder('auto', true, caps(['vp8', 'h264_vaapi', 'vp9_vaapi'])).selected, 'h264_vaapi');
    assert.equal(selectEncoder('auto', true, caps(['vp8', 'vp9_vaapi', 'vp8_vaapi'])).selected, 'vp9_vaapi');
    assert.equal(selectEncoder('auto', true, caps(['vp8', 'vp8_vaapi'])).selected, 'vp8_vaapi');
  });

  it('uses NVENC on a host with no VAAPI device', () => {
    // An NVIDIA-only host: no render node, but the NVENC test encode passed.
    const nvidia = caps(['vp8', 'vp9', 'h264', 'h264_nvenc'], false);
    assert.deepEqual(selectEncoder('auto', true, nvidia), { selected: 'h264_nvenc', note: null });
    assert.deepEqual(selectEncoder('auto', false, nvidia), { selected: 'vp8', note: null });
    assert.equal(ENCODER_CODEC.h264_nvenc, 'h264');
    assert.equal(isHardwareEncoder('h264_nvenc'), true);
    assert.equal(isHardwareEncoder('h264'), false);
    assert.equal(normalizeEncoderRequest('h264_nvenc', 'auto'), 'h264_nvenc');
  });

  it('explains software when hardware was preferred but unusable', () => {
    const noDevice = selectEncoder('auto', true, caps(['vp8'], false));
    assert.equal(noDevice.selected, 'vp8');
    assert.match(noDevice.note ?? '', /no working hardware encoder passed the test encode/);
    const failed = selectEncoder('auto', true, caps(['vp8'], true));
    assert.match(failed.note ?? '', /test encode/);
    const unknown = selectEncoder('auto', true, null);
    assert.equal(unknown.selected, 'vp8');
    assert.match(unknown.note ?? '', /unavailable/);
  });

  it('uses AMF when its probe passes without a VAAPI device', () => {
    const amd = caps(['vp8', 'vp9', 'h264', 'h264_amf'], false);
    assert.deepEqual(selectEncoder('auto', true, amd), { selected: 'h264_amf', note: null });
    assert.deepEqual(selectEncoder('auto', false, amd), { selected: 'vp8', note: null });
    assert.deepEqual(selectEncoder('h264_amf', false, null), { selected: 'h264_amf', note: null });
    assert.equal(ENCODER_CODEC.h264_amf, 'h264');
    assert.equal(isHardwareEncoder('h264_amf'), true);
    assert.equal(normalizeEncoderRequest('h264_amf', 'auto'), 'h264_amf');
    assert.equal(encoderDisplayName('h264_amf'), 'H.264 (AMF)');
  });

  it('keeps VAAPI and NVENC ahead of AMF when several probes pass', () => {
    assert.equal(selectEncoder('auto', true, caps(['h264_vaapi', 'h264_nvenc', 'h264_amf'])).selected, 'h264_vaapi');
    assert.equal(selectEncoder('auto', true, caps(['h264_nvenc', 'h264_amf'], false)).selected, 'h264_nvenc');
  });

  it('normalizes encoder requests', () => {
    assert.equal(normalizeEncoderRequest('h264', 'auto'), 'h264');
    assert.equal(normalizeEncoderRequest('nvenc', 'auto'), 'auto');
  });
});

describe('stream start encoder resolution', () => {
  const amd = caps(['vp8', 'vp9', 'h264', 'h264_amf'], false);

  it('honors persisted Auto + preferHardware for Use server default', () => {
    const settings = parseVideoStreamingSettings(new Map([
      [VIDEO_DEFAULT_ENCODER_KEY, 'auto'],
      [VIDEO_PREFER_HARDWARE_KEY, 'true'],
    ]));
    assert.equal(settings.defaultEncoder, 'auto');
    assert.equal(settings.preferHardware, true);
    // omitted options.encoder = "Use server default"
    assert.equal(resolveStartEncoder(undefined, settings, amd).selected, 'h264_amf');
  });

  it('keeps explicit per-stream Auto on the server hardware preference', () => {
    const settings = parseVideoStreamingSettings(new Map([
      [VIDEO_DEFAULT_ENCODER_KEY, 'vp9'],
      [VIDEO_PREFER_HARDWARE_KEY, 'true'],
    ]));
    assert.equal(resolveStartEncoder('auto', settings, amd).selected, 'h264_amf');
  });

  it('stays on VP8 when Auto prefers hardware is off (default)', () => {
    const settings = videoStreamingDefaults({});
    assert.equal(settings.preferHardware, false);
    assert.equal(resolveStartEncoder(undefined, settings, amd).selected, 'vp8');
    assert.equal(resolveStartEncoder('auto', settings, amd).selected, 'vp8');
  });

  it('keeps software fallback when AMF is unavailable', () => {
    const settings = parseVideoStreamingSettings(new Map([
      [VIDEO_DEFAULT_ENCODER_KEY, 'auto'],
      [VIDEO_PREFER_HARDWARE_KEY, 'true'],
    ]));
    assert.equal(resolveStartEncoder(undefined, settings, null).selected, 'vp8');
    assert.equal(resolveStartEncoder('auto', settings, caps(['vp8'], false)).selected, 'vp8');
  });

  it('leaves explicit H.264 AMF unchanged', () => {
    const settings = videoStreamingDefaults({});
    assert.equal(resolveStartEncoder('h264_amf', settings, null).selected, 'h264_amf');
  });
});
