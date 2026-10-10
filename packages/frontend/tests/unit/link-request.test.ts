import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_VIDEO_START_OPTIONS } from '../../src/lib/video-options';
import {
  buildLinkStartRequest,
  isBarePlaylistUrl,
  isRemoteMediaUrl,
  musicPlayAllowed,
  queuedVideoToast,
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

  it('default options inherit quality, encoder and timeout', () => {
    const body = buildLinkStartRequest('clip.mp4', 'video', DEFAULT_VIDEO_START_OPTIONS).body;
    assert.equal('preset' in body, false);
    assert.equal('encoder' in body, false);
    assert.equal('noViewerTimeoutSec' in body, false);
    assert.equal(body.sourceMode, 'auto');
  });
});

describe('console link request: video queue', () => {
  const playlist = 'https://www.youtube.com/playlist?list=PL123';

  it('music never uses the video queue, even while a video streams', () => {
    assert.equal(buildLinkStartRequest('https://youtu.be/abc', 'music', DEFAULT_VIDEO_START_OPTIONS, true).endpoint, 'play-url');
  });

  it('video with nothing streaming starts a stream', () => {
    assert.equal(buildLinkStartRequest('https://youtu.be/abc', 'video', DEFAULT_VIDEO_START_OPTIONS, false).endpoint, 'stream/start');
    assert.equal(buildLinkStartRequest('https://youtu.be/abc', 'video').endpoint, 'stream/start');
  });

  it('video while a video streams is queued', () => {
    assert.deepEqual(
      buildLinkStartRequest('  https://youtu.be/abc ', 'video', DEFAULT_VIDEO_START_OPTIONS, true),
      { endpoint: 'stream/queue', body: { source: 'https://youtu.be/abc', sourceMode: 'auto' } },
    );
    assert.equal(buildLinkStartRequest('clip.mp4', 'video', DEFAULT_VIDEO_START_OPTIONS, true).endpoint, 'stream/queue');
  });

  it('a bare playlist link with nothing streaming goes to the queue', () => {
    assert.deepEqual(
      buildLinkStartRequest(playlist, 'video', DEFAULT_VIDEO_START_OPTIONS, false),
      { endpoint: 'stream/queue', body: { source: playlist, sourceMode: 'auto' } },
    );
  });

  it('recognises bare YouTube playlist links only', () => {
    assert.equal(isBarePlaylistUrl(playlist), true);
    assert.equal(isBarePlaylistUrl('https://music.youtube.com/playlist?list=PL123'), true);
    assert.equal(isBarePlaylistUrl('https://www.youtube.com/watch?v=abc&list=PL123'), false);
    assert.equal(isBarePlaylistUrl('https://example.com/playlist?list=PL123'), false);
    assert.equal(isBarePlaylistUrl('list=PL123.mp4'), false);
  });

  it('words the toast for one video and for a playlist', () => {
    assert.equal(queuedVideoToast({ queued: 1, started: true }), 'Video stream started');
    assert.equal(queuedVideoToast({ queued: 1, started: false }), 'Added to Up next');
    assert.equal(queuedVideoToast({ queued: 12, started: true, playlistTitle: 'Road trip' }), 'Queued 12 videos from Road trip');
    assert.equal(queuedVideoToast({ queued: 12, started: false }), 'Queued 12 videos');
    assert.equal(
      queuedVideoToast({ queued: 25, started: false, playlistTitle: 'Road trip', truncated: true }),
      'Queued 25 videos from Road trip (first 25)',
    );
    assert.equal(queuedVideoToast({ queued: 1, started: false, playlistTitle: 'Solo' }), 'Queued 1 video from Solo');
  });
});
