import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_VIDEO_START_OPTIONS, videoOptionsSummary, videoStartDefaults, videoStartRequest,
} from '../../src/lib/video-options';

describe('console video options', () => {
  it('start on Auto quality and the server streaming defaults', () => {
    assert.deepEqual(videoStartDefaults({ defaultEncoder: 'h264_vaapi', noViewerTimeoutSec: 900 }, 'live'), {
      quality: 'auto', encoder: 'h264_vaapi', noViewerTimeout: '900', sourceMode: 'live',
    });
  });

  it('fall back to Auto and the server timeout before the defaults load', () => {
    assert.deepEqual(DEFAULT_VIDEO_START_OPTIONS, {
      quality: 'auto', encoder: 'auto', noViewerTimeout: '', sourceMode: 'auto',
    });
    // A malformed settings response is treated as not loaded.
    assert.deepEqual(videoStartDefaults({} as never), DEFAULT_VIDEO_START_OPTIONS);
    assert.deepEqual(videoStartRequest(DEFAULT_VIDEO_START_OPTIONS), {
      preset: 'auto', encoder: 'auto', noViewerTimeoutSec: undefined, sourceMode: 'auto',
    });
  });

  it('passes explicit choices through', () => {
    assert.deepEqual(
      videoStartRequest({ quality: '1080p', encoder: 'h264_vaapi', noViewerTimeout: '600', sourceMode: 'live' }),
      { preset: '1080p', encoder: 'h264_vaapi', noViewerTimeoutSec: 600, sourceMode: 'live' },
    );
  });

  it('sends 0 when the no-viewer stop is turned off', () => {
    assert.equal(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, noViewerTimeout: '0' }).noViewerTimeoutSec, 0);
  });
});

describe('console video options summary', () => {
  it('names every current choice on one line', () => {
    assert.equal(
      videoOptionsSummary(videoStartDefaults({ defaultEncoder: 'auto', noViewerTimeoutSec: 300 })),
      'Auto · Auto encoder · stops after 5 min · Detect',
    );
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
