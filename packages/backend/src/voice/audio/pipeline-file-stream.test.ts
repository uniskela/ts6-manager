import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPcmFileArgs } from './pipeline.js';

describe('buildPcmFileArgs', () => {
  it('paces finite file decoding in real time so PCM cannot race ahead into memory', () => {
    const args = buildPcmFileArgs('/data/music/example.mp3');

    assert.deepEqual(args.slice(0, 3), ['-re', '-i', '/data/music/example.mp3']);
    assert.equal(args.includes('-ss'), false);
    assert.equal(args.includes('s16le'), true);
    assert.deepEqual(args.slice(-3), ['-loglevel', 'error', 'pipe:1']);
  });

  it('places the seek offset and real-time input pacing before the input', () => {
    const args = buildPcmFileArgs('/data/music/example.mp3', 123.4567);

    assert.deepEqual(args.slice(0, 5), ['-ss', '123.457', '-re', '-i', '/data/music/example.mp3']);
  });
});
