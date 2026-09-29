import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  effectiveBitrate,
  normalizeQualityRequest,
  parseBitrateKbps,
  resolveQuality,
  selectAutoPreset,
} from './quality.js';

describe('selectAutoPreset', () => {
  it('never upscales: a 720p source stays 720p even with a 2160p limit', () => {
    assert.equal(selectAutoPreset(1280, 720, '2160p'), '720p');
  });

  it('picks the largest preset the source fills, up to the limit', () => {
    assert.equal(selectAutoPreset(3840, 2160, '2160p'), '2160p');
    assert.equal(selectAutoPreset(3840, 2160, '1440p'), '1440p');
    assert.equal(selectAutoPreset(2560, 1440, '2160p'), '1440p');
    assert.equal(selectAutoPreset(1920, 1080, '1080p'), '1080p');
  });

  it('handles letterboxed and portrait sources by how they fit the frame', () => {
    // 2.39:1 1080p film: full width, short height.
    assert.equal(selectAutoPreset(1920, 804, '2160p'), '1080p');
    // Portrait 1080x1920 fits a 1440p frame at 810x1440 (downscaled); 2160p would upscale it.
    assert.equal(selectAutoPreset(1080, 1920, '2160p'), '1440p');
    assert.equal(selectAutoPreset(1080, 1920, '1080p'), '1080p');
  });

  it('tolerates slightly short sources (e.g. 1916x1076)', () => {
    assert.equal(selectAutoPreset(1916, 1076, '2160p'), '1080p');
  });

  it('falls back to the smallest preset for tiny sources', () => {
    assert.equal(selectAutoPreset(320, 240, '2160p'), '480p');
  });
});

describe('resolveQuality', () => {
  it('uses a fixed preset as-is without source dimensions', () => {
    const q = resolveQuality('1440p', '1080p', null);
    assert.equal(q.actual, '1440p');
    assert.equal(q.width, 2560);
    assert.equal(q.sourceWidth, null);
    assert.equal(q.note, null);
  });

  it('reports requested → actual for Auto', () => {
    const q = resolveQuality('auto', '2160p', { width: 1920, height: 1080 });
    assert.equal(q.requested, 'auto');
    assert.equal(q.actual, '1080p');
    assert.equal(q.sourceHeight, 1080);
    assert.equal(q.note, null);
  });

  it('notes when the Auto limit capped the choice', () => {
    const q = resolveQuality('auto', '1080p', { width: 3840, height: 2160 });
    assert.equal(q.actual, '1080p');
    assert.match(q.note ?? '', /Auto limit \(1080p\)/);
  });

  it('falls back to the capped default when the probe failed', () => {
    assert.equal(resolveQuality('auto', '1080p', null).actual, '720p');
    const low = resolveQuality('auto', '480p', null);
    assert.equal(low.actual, '480p');
    assert.match(low.note ?? '', /unknown/);
  });
});

describe('bitrates', () => {
  it('parses ffmpeg-style bitrates', () => {
    assert.equal(parseBitrateKbps('4500k'), 4500);
    assert.equal(parseBitrateKbps('4500K'), 4500);
    assert.equal(parseBitrateKbps('4500'), 4500);
    assert.equal(parseBitrateKbps('4.5M'), 4500);
    assert.equal(parseBitrateKbps('fast'), null);
    assert.equal(parseBitrateKbps(''), null);
  });

  it('uses the preset bitrate unless overridden, then clamps', () => {
    assert.equal(effectiveBitrate(null, '14000k', 0), '14000k');
    assert.equal(effectiveBitrate(null, '14000k', 8000), '8000k');
    assert.equal(effectiveBitrate('3000k', '14000k', 8000), '3000k');
    assert.equal(effectiveBitrate('20000k', '4500k', 8000), '8000k');
    assert.equal(effectiveBitrate('garbage', '4500k', 0), '4500k');
  });

  it('normalizes quality requests', () => {
    assert.equal(normalizeQualityRequest('auto', '720p'), 'auto');
    assert.equal(normalizeQualityRequest('2160p', '720p'), '2160p');
    assert.equal(normalizeQualityRequest('4k', '720p'), '720p');
    assert.equal(normalizeQualityRequest(undefined, '720p'), '720p');
  });
});
