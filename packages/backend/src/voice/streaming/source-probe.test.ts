import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProbeResolution, probeSourceResolution, sourceProbeArgs } from './source-probe.js';

describe('source probe', () => {
  it('bounds network reads for http sources only', () => {
    assert.ok(sourceProbeArgs('https://example.com/live.m3u8').includes('-rw_timeout'));
    assert.ok(!sourceProbeArgs('/data/music/clip.mp4').includes('-rw_timeout'));
    const args = sourceProbeArgs('/data/music/clip.mp4');
    assert.equal(args[args.length - 1], '/data/music/clip.mp4');
  });

  it('parses ffprobe json', () => {
    assert.deepEqual(parseProbeResolution('{"streams":[{"width":1920,"height":1080}]}'), { width: 1920, height: 1080 });
    assert.equal(parseProbeResolution('{"streams":[]}'), null);
    assert.equal(parseProbeResolution('{"streams":[{"width":0,"height":0}]}'), null);
    assert.equal(parseProbeResolution('not json'), null);
    assert.equal(parseProbeResolution(null), null);
  });

  it('returns null on probe failure and never probes option-like input', async () => {
    let calls = 0;
    const failing = async () => { calls++; return null; };
    assert.equal(await probeSourceResolution('https://example.com/x', failing), null);
    assert.equal(await probeSourceResolution('-i /etc/passwd', failing), null);
    assert.equal(calls, 1);
  });
});
