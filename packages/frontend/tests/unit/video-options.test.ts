import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_VIDEO_START_OPTIONS, videoStartRequest } from '../../src/lib/video-options';

describe('console video options', () => {
  it('defaults leave every choice to the server streaming defaults', () => {
    assert.deepEqual(videoStartRequest(DEFAULT_VIDEO_START_OPTIONS), {
      preset: 'auto', encoder: undefined, noViewerTimeoutSec: undefined, sourceMode: 'auto',
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
