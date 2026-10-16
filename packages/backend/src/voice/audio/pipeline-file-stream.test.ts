import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it, mock } from 'node:test';
import { setMediaEgressProxyForTests } from '../egress/media-egress.js';
import { AudioPipeline, buildPcmFileArgs } from './pipeline.js';

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

  it('lets a remote track open only HTTP(S) through a proxy', () => {
    const args = buildPcmFileArgs('https://rr1.googlevideo.com/videoplayback?id=1');
    const at = args.indexOf('-protocol_whitelist');
    assert.ok(at >= 0 && at < args.indexOf('-i'));
    assert.equal(args[at + 1], 'http,https,tls,tcp,httpproxy,crypto');
    const formats = args.indexOf('-format_whitelist');
    assert.ok(formats >= 0 && formats < args.indexOf('-i'), 'playlist formats are refused');
    assert.doesNotMatch(args[formats + 1], /hls|dash|concat/);
    assert.equal(buildPcmFileArgs('/data/music/example.mp3').includes('-protocol_whitelist'), false);
  });

  it('starts ffmpeg for a remote track with its own media egress proxy, released when ffmpeg exits', async () => {
    setMediaEgressProxyForTests(undefined);
    const previous = process.env.MEDIA_EGRESS_PROXY;
    delete process.env.MEDIA_EGRESS_PROXY;
    const calls: Array<{ env: NodeJS.ProcessEnv }> = [];
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
    const spawn = mock.method(childProcess, 'spawn', (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ env: options.env });
      return proc;
    });
    syncBuiltinESMExports();
    try {
      await new AudioPipeline().toPcmFileStream('https://93.184.215.14/track.webm');
      assert.match(calls[0].env.https_proxy ?? '', /^http:\/\/job:[0-9a-f]{64}@127\.0\.0\.1:\d+$/);
      assert.equal(calls[0].env.no_proxy, undefined);
      await new AudioPipeline().toPcmFileStream('/data/music/local.mp3');
      assert.equal(calls[1].env.https_proxy, process.env.https_proxy, 'a local file gets no proxy');
      proc.emit('close', 0);
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
      if (previous === undefined) delete process.env.MEDIA_EGRESS_PROXY; else process.env.MEDIA_EGRESS_PROXY = previous;
      setMediaEgressProxyForTests(undefined);
    }
  });
});
