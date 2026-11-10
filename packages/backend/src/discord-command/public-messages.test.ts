import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../middleware/error-handler.js';
import {
  MEDIA_EGRESS_OFF_REFUSAL,
  MEDIA_LINK_UNAVAILABLE,
  MediaEgressError,
} from '../voice/egress/media-egress.js';
import { RADIO_FETCHER_UNAVAILABLE } from '../voice/egress/media-fetcher-client.js';
import { MediaSessionConflictError } from '../voice/media-session.js';
import { QueueFullError } from '../voice/playlist/queue.js';
import { publicCommandError } from './public-messages.js';

describe('publicCommandError (finding #9)', () => {
  it('keeps crafted conflict and queue-full messages', () => {
    const conflict = new MediaSessionConflictError('music', [{
      id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      kind: 'video',
      state: 'active',
      botId: 1,
      botName: 'Bot',
      startedAt: 0,
      label: 'Clip',
    }]);
    assert.match(publicCommandError(conflict, 'fallback'), /video stream.*Bot/i);
    assert.match(publicCommandError(new QueueFullError(2, 0), 'fallback'), /queue is full/i);
  });

  it('finding #20: allowlists stable MediaEgressError texts only', () => {
    assert.equal(
      publicCommandError(new MediaEgressError(RADIO_FETCHER_UNAVAILABLE), 'Radio playback failed.'),
      RADIO_FETCHER_UNAVAILABLE,
    );
    assert.equal(
      publicCommandError(new MediaEgressError(MEDIA_LINK_UNAVAILABLE), 'Radio playback failed.'),
      MEDIA_LINK_UNAVAILABLE,
    );
    assert.equal(
      publicCommandError(new MediaEgressError(MEDIA_EGRESS_OFF_REFUSAL), 'Radio playback failed.'),
      MEDIA_EGRESS_OFF_REFUSAL,
    );
  });

  it('hides unexpected MediaEgressError contents and other internals', () => {
    assert.equal(
      publicCommandError(
        new MediaEgressError('ffmpeg failed open https://u:p@host/x?token=abc'),
        'Radio playback failed.',
      ),
      'Radio playback failed.',
    );
    assert.equal(
      publicCommandError(new AppError(400, 'https://u:p@host/x?token=abc'), 'Playback failed.'),
      'Playback failed.',
    );
    assert.equal(
      publicCommandError(new Error('ENOENT /etc/shadow stack at internal.ts:1 token=xyz'), 'Playback failed.'),
      'Playback failed.',
    );
  });
});

