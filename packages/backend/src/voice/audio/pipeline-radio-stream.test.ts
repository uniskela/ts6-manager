import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it, mock } from 'node:test';
import { setMediaEgressProxyForTests } from '../egress/media-egress.js';
import { AudioPipeline, buildPcmStreamArgs } from './pipeline.js';

describe('buildPcmStreamArgs', () => {
  it('lets radio open HTTP(S) through the media egress proxy, including HLS', () => {
    const args = buildPcmStreamArgs('https://203.0.113.10/live');
    const protocols = args[args.indexOf('-protocol_whitelist') + 1];
    const formats = args[args.indexOf('-format_whitelist') + 1];
    assert.ok(args.includes('-reconnect'));
    assert.equal(protocols, 'http,https,tls,tcp,httpproxy,crypto');
    assert.match(formats, /hls/);
    assert.doesNotMatch(formats, /concat|file|udp|rtp/);
    assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', 'https://203.0.113.10/live']);
  });
});

describe('toPcmStream media egress', () => {
  it('fails closed without spawning ffmpeg when MEDIA_EGRESS_PROXY=off', async () => {
    setMediaEgressProxyForTests(undefined);
    const previous = process.env.MEDIA_EGRESS_PROXY;
    process.env.MEDIA_EGRESS_PROXY = 'off';
    const spawn = mock.method(childProcess, 'spawn', () => {
      throw new Error('must not spawn');
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => new AudioPipeline().toPcmStream('https://93.184.215.14/radio'),
        /only YouTube|could not be loaded|MEDIA_EGRESS_PROXY/i,
      );
      assert.equal(spawn.mock.calls.length, 0);
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
      if (previous === undefined) delete process.env.MEDIA_EGRESS_PROXY; else process.env.MEDIA_EGRESS_PROXY = previous;
      setMediaEgressProxyForTests(undefined);
    }
  });

  it('fails closed without spawning ffmpeg when the proxy cannot be issued', async () => {
    setMediaEgressProxyForTests(undefined);
    const previous = { proxy: process.env.MEDIA_EGRESS_PROXY, upstream: process.env.MEDIA_UPSTREAM_PROXY };
    delete process.env.MEDIA_EGRESS_PROXY;
    process.env.MEDIA_UPSTREAM_PROXY = 'socks5://proxy:1080';
    const spawn = mock.method(childProcess, 'spawn', () => {
      throw new Error('must not spawn');
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => new AudioPipeline().toPcmStream('https://93.184.215.14/radio'));
      assert.equal(spawn.mock.calls.length, 0);
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
      if (previous.proxy === undefined) delete process.env.MEDIA_EGRESS_PROXY; else process.env.MEDIA_EGRESS_PROXY = previous.proxy;
      if (previous.upstream === undefined) delete process.env.MEDIA_UPSTREAM_PROXY; else process.env.MEDIA_UPSTREAM_PROXY = previous.upstream;
      setMediaEgressProxyForTests(undefined);
    }
  });

  it('starts ffmpeg for radio with a checked proxy and releases it when ffmpeg exits', async () => {
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
      await new AudioPipeline().toPcmStream('https://93.184.215.14/radio');
      assert.match(calls[0].env.https_proxy ?? '', /^http:\/\/job:[0-9a-f]{64}@127\.0\.0\.1:\d+$/);
      assert.equal(calls[0].env.no_proxy, undefined);
    } finally {
      proc.emit('close', 0);
      spawn.mock.restore();
      syncBuiltinESMExports();
      if (previous === undefined) delete process.env.MEDIA_EGRESS_PROXY; else process.env.MEDIA_EGRESS_PROXY = previous;
      setMediaEgressProxyForTests(undefined);
    }
  });
});
