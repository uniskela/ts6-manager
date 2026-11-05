import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../middleware/error-handler.js';
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

  it('hides generic AppError and unexpected internals', () => {
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
