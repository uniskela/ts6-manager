import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPcmFileArgs } from './pipeline.js';

describe('buildPcmFileArgs', () => {
  it('builds an incremental PCM pipeline without a seek offset by default', () => {
    const args = buildPcmFileArgs('/data/music/example.mp3');

    assert.deepEqual(args.slice(0, 2), ['-i', '/data/music/example.mp3']);
    assert.deepEqual(args.slice(-2), ['-loglevel', 'error', 'pipe:1'].slice(-2));
    assert.equal(args.includes('-ss'), false);
    assert.equal(args.includes('s16le'), true);
  });

  it('places the seek offset before the input so ffmpeg starts at the requested position', () => {
    const args = buildPcmFileArgs('/data/music/example.mp3', 123.4567);

    assert.deepEqual(args.slice(0, 4), ['-ss', '123.457', '-i', '/data/music/example.mp3']);
  });
});
