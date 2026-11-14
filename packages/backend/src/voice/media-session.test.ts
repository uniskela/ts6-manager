import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MediaSessionConflictError,
  parseReplaceSessionIds,
  publicMediaTitle,
  safeSourceLabel,
  safeUrlDisplayTitle,
} from './media-session.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('media session helpers', () => {
  it('never exposes URL paths, queries or credentials in labels', () => {
    assert.equal(safeSourceLabel('https://user:pass@iptv.example.com/live/123/token.m3u8?auth=x'), 'iptv.example.com');
    assert.equal(safeSourceLabel('/data/music/.stream-1700000000.mp4'), 'Downloaded video');
    assert.equal(safeSourceLabel('/data/music/intro.mp4'), 'intro.mp4');
    assert.equal(safeSourceLabel(null), null);
  });

  it('finding #9: safeUrlDisplayTitle and publicMediaTitle hide credentials and query tokens', () => {
    const secretUrl = 'https://user:s3cret@media.example.test/stream.m3u8?token=abc123&sig=zzzz';
    assert.equal(safeUrlDisplayTitle(secretUrl), 'Media from media.example.test');
    assert.equal(publicMediaTitle(secretUrl), 'Media from media.example.test');
    assert.equal(publicMediaTitle(secretUrl, secretUrl), 'Media from media.example.test');
    assert.equal(publicMediaTitle('Nice Song', secretUrl), 'Nice Song');
    assert.doesNotMatch(publicMediaTitle(secretUrl), /s3cret|abc123|user:/);
  });

  it('accepts only UUID session IDs, array or legacy single field', () => {
    assert.deepEqual(parseReplaceSessionIds({ replaceSessionIds: [ID, 'nope', 5] }), [ID]);
    assert.deepEqual(parseReplaceSessionIds({ replaceSessionId: ID }), [ID]);
    assert.deepEqual(parseReplaceSessionIds(undefined), []);
  });

  it('describes the conflict for the confirmation prompt', () => {
    const err = new MediaSessionConflictError('video', [{
      id: ID, kind: 'music', state: 'active', botId: 1, botName: 'Aurora', startedAt: 0, label: 'Song',
    }]);
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /Music is playing on Aurora\. Starting the video stream will stop it\./);
  });
});
