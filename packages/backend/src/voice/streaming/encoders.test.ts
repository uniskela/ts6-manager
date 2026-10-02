import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VideoEncoderCapabilities } from '@ts6/common';
import { ENCODER_CODEC, isHardwareEncoder, normalizeEncoderRequest, selectEncoder } from './encoders.js';

function caps(available: string[], devicePresent = true): VideoEncoderCapabilities {
  const ids = ['vp8', 'vp9', 'h264', 'vp8_vaapi', 'vp9_vaapi', 'h264_vaapi', 'h264_nvenc'] as const;
  return {
    checkedAt: new Date(0).toISOString(),
    vaapiDevice: '/dev/dri/renderD128',
    vaapiDevicePresent: devicePresent,
    hwDecode: false,
    encoders: ids.map((id) => ({
      id,
      codec: ENCODER_CODEC[id],
      hardware: id.endsWith('_vaapi') || id.endsWith('_nvenc'),
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
    assert.match(noDevice.note ?? '', /no VAAPI device/);
    const failed = selectEncoder('auto', true, caps(['vp8'], true));
    assert.match(failed.note ?? '', /test encode/);
    const unknown = selectEncoder('auto', true, null);
    assert.equal(unknown.selected, 'vp8');
    assert.match(unknown.note ?? '', /unavailable/);
  });

  it('normalizes encoder requests', () => {
    assert.equal(normalizeEncoderRequest('h264', 'auto'), 'h264');
    assert.equal(normalizeEncoderRequest('nvenc', 'auto'), 'auto');
  });
});
