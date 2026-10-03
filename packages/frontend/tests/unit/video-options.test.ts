import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_VIDEO_START_OPTIONS, videoOptionsSummary, videoStartDefaults, videoStartRequest,
} from '../../src/lib/video-options';

describe('console video options', () => {
  it('inherits quality, encoder and timeout without overriding source detection', () => {
    assert.deepEqual(DEFAULT_VIDEO_START_OPTIONS, {
      quality: '', encoder: '', noViewerTimeout: '', sourceMode: 'auto',
    });
    assert.deepEqual(videoStartRequest(DEFAULT_VIDEO_START_OPTIONS), { sourceMode: 'auto' });
  });

  it('keeps IPTV live while inheriting the streaming defaults', () => {
    assert.deepEqual(videoStartDefaults('live'), {
      quality: '', encoder: '', noViewerTimeout: '', sourceMode: 'live',
    });
    assert.deepEqual(videoStartRequest(videoStartDefaults('live')), { sourceMode: 'live' });
  });

  it('passes explicit choices through', () => {
    assert.deepEqual(
      videoStartRequest({ quality: '1080p', encoder: 'h264_vaapi', noViewerTimeout: '600', sourceMode: 'live' }),
      { preset: '1080p', encoder: 'h264_vaapi', noViewerTimeoutSec: 600, sourceMode: 'live' },
    );
  });

  it('distinguishes explicit Auto from inheriting the defaults', () => {
    assert.deepEqual(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, quality: 'auto', encoder: 'auto' }), {
      preset: 'auto', encoder: 'auto', sourceMode: 'auto',
    });
  });

  it('inherits each field independently of explicit overrides', () => {
    assert.deepEqual(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, quality: '720p' }), {
      preset: '720p', sourceMode: 'auto',
    });
    assert.deepEqual(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, encoder: 'vp9' }), {
      encoder: 'vp9', sourceMode: 'auto',
    });
    assert.deepEqual(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, noViewerTimeout: '900' }), {
      noViewerTimeoutSec: 900, sourceMode: 'auto',
    });
  });

  it('sends 0 when the no-viewer stop is turned off', () => {
    assert.equal(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, noViewerTimeout: '0' }).noViewerTimeoutSec, 0);
  });
});

describe('console video options summary', () => {
  it('identifies inherited defaults', () => {
    assert.equal(videoOptionsSummary(videoStartDefaults('live')),
      'Default quality · Default encoder · default auto-stop · Live');
  });

  it('names every explicit choice on one line', () => {
    assert.equal(
      videoOptionsSummary({ quality: '1080p', encoder: 'auto', noViewerTimeout: '0', sourceMode: 'live' }),
      '1080p · Auto encoder · no auto-stop · Live',
    );
    assert.equal(
      videoOptionsSummary({ quality: 'auto', encoder: 'auto', noViewerTimeout: '900', sourceMode: 'auto' }),
      'Auto · Auto encoder · stops after 15 min · Detect',
    );
  });
});
