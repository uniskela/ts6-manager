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

  it('reconnects a remote track and still paces it in real time', () => {
    const url = 'https://rr1.googlevideo.com/videoplayback?id=1';
    const args = buildPcmFileArgs(url, 30);

    assert.deepEqual(args.slice(0, 2), ['-ss', '30.000']);
    assert.ok(args.includes('-reconnect'));
    assert.deepEqual(args.slice(args.indexOf('-re'), args.indexOf('-re') + 3), ['-re', '-i', url]);
    assert.equal(buildPcmFileArgs('/data/music/example.mp3').includes('-reconnect'), false);
  });
});
