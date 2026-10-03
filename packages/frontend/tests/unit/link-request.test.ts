import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_VIDEO_START_OPTIONS } from '../../src/lib/video-options';
import {
  buildLinkStartRequest,
  isRemoteMediaUrl,
  musicPlayAllowed,
} from '../../src/pages/bot-hub/link-request';

describe('console link request mapping', () => {
  it('treats http(s) URLs as remote and bare filenames as local', () => {
    assert.equal(isRemoteMediaUrl('https://youtu.be/abc'), true);
    assert.equal(isRemoteMediaUrl('http://example.com/a.mp3'), true);
    assert.equal(isRemoteMediaUrl('  https://twitch.tv/x  '), true);
    assert.equal(isRemoteMediaUrl('clip.mp4'), false);
    assert.equal(isRemoteMediaUrl('folder/clip.mp4'), false);
    assert.equal(musicPlayAllowed('https://youtu.be/abc'), true);
    assert.equal(musicPlayAllowed('clip.mp4'), false);
  });

  it('maps Play as music to play-url with the trimmed URL', () => {
    assert.deepEqual(
      buildLinkStartRequest('  https://youtu.be/abc  ', 'music'),
      { endpoint: 'play-url', body: { url: 'https://youtu.be/abc' } },
    );
  });

  it('maps Stream as video to stream/start with the source', () => {
    assert.deepEqual(
      buildLinkStartRequest('https://youtu.be/abc', 'video', DEFAULT_VIDEO_START_OPTIONS),
      {
        endpoint: 'stream/start',
        body: {
          source: 'https://youtu.be/abc',
          preset: 'auto',
          encoder: 'auto',
          noViewerTimeoutSec: undefined,
          sourceMode: 'auto',
        },
      },
    );
  });

  it('passes a bare music-folder filename through as the video source', () => {
    assert.deepEqual(
      buildLinkStartRequest('show.mp4', 'video', DEFAULT_VIDEO_START_OPTIONS).body,
      {
        source: 'show.mp4',
        preset: 'auto',
        encoder: 'auto',
        noViewerTimeoutSec: undefined,
        sourceMode: 'auto',
      },
    );
  });

  it('passes chosen video options through', () => {
    assert.deepEqual(
      buildLinkStartRequest('https://youtu.be/abc', 'video', {
        quality: '1080p',
        encoder: 'h264_vaapi',
        noViewerTimeout: '600',
        sourceMode: 'live',
      }).body,
      {
        source: 'https://youtu.be/abc',
        preset: '1080p',
        encoder: 'h264_vaapi',
        noViewerTimeoutSec: 600,
        sourceMode: 'live',
      },
    );
  });

  it('default options send Auto and leave the timeout to the server', () => {
    const body = buildLinkStartRequest('clip.mp4', 'video', DEFAULT_VIDEO_START_OPTIONS).body;
    assert.equal(body.preset, 'auto');
    assert.equal(body.encoder, 'auto');
    assert.equal(body.noViewerTimeoutSec, undefined);
    assert.equal(body.sourceMode, 'auto');
  });
});
