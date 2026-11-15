import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it, mock } from 'node:test';
import { setMediaEgressProxyForTests } from '../egress/media-egress.js';
import { RADIO_FETCHER_UNAVAILABLE } from '../egress/media-fetcher-client.js';
import { AudioPipeline, assertFfmpegHttpsVerification, buildPcmStreamArgs, resetFfmpegHttpsVerificationForTests } from './pipeline.js';

describe('buildPcmStreamArgs', () => {
  it('lets radio open HTTP(S) through the media egress proxy, including HLS, with TLS verification', () => {
    const args = buildPcmStreamArgs('https://203.0.113.10/live');
    const protocols = args[args.indexOf('-protocol_whitelist') + 1];
    const formats = args[args.indexOf('-format_whitelist') + 1];
    assert.ok(args.includes('-reconnect'));
    assert.equal(args[args.indexOf('-tls_verify') + 1], '1');
    assert.ok(args.indexOf('-tls_verify') < args.indexOf('-i'));
    assert.equal(buildPcmStreamArgs('http://203.0.113.10/live').includes('-tls_verify'), false);
    assert.equal(protocols, 'http,https,tls,tcp,httpproxy,crypto');
    assert.match(formats, /hls/);
    assert.doesNotMatch(formats, /concat|file|udp|rtp/);
    assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', 'https://203.0.113.10/live']);
  });
});

describe('assertFfmpegHttpsVerification', () => {
  it('refuses OpenSSL-only ffmpeg that cannot verify host names per request', () => {
    resetFfmpegHttpsVerificationForTests();
    try {
      assert.throws(() => assertFfmpegHttpsVerification((command, args) => {
        const help = args.includes('protocol=tls');
        return {
          status: 0,
          error: undefined,
          stdout: help ? '  -tls_verify        <int>        ED\n' : 'configuration: --enable-openssl --enable-gpl\n',
          stderr: '',
        } as ReturnType<typeof childProcess.spawnSync>;
      }), /host names/);
    } finally {
      resetFfmpegHttpsVerificationForTests();
    }
  });
});

/**
 * All remote radio entry points call toPcmStream:
 * TeamSpeak !radio, Discord /radio, web Play, listener requests,
 * Auto-DJ radio, queue next/prev, and VoiceBot.play() when streamUrl is set.
 */
describe('toPcmStream media egress', () => {
  async function expectFailClosed(url = 'https://93.184.215.14/radio'): Promise<void> {
    const spawn = mock.method(childProcess, 'spawn', () => {
      throw new Error('must not spawn');
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => new AudioPipeline().toPcmStream(url),
        (err: Error) => err.message === RADIO_FETCHER_UNAVAILABLE,
      );
      assert.equal(spawn.mock.calls.length, 0);
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  }

  function restoreEnv(previous: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  it('fails closed without spawning ffmpeg when MEDIA_FETCHER is unset', async () => {
    const previous = {
      MEDIA_FETCHER: process.env.MEDIA_FETCHER,
      MEDIA_FETCHER_SOCK: process.env.MEDIA_FETCHER_SOCK,
      MEDIA_FETCHER_TOKEN_FILE: process.env.MEDIA_FETCHER_TOKEN_FILE,
    };
    delete process.env.MEDIA_FETCHER;
    delete process.env.MEDIA_FETCHER_SOCK;
    delete process.env.MEDIA_FETCHER_TOKEN_FILE;
    try {
      await expectFailClosed();
    } finally {
      restoreEnv(previous);
    }
  });

  it('fails closed without spawning ffmpeg when MEDIA_FETCHER=0', async () => {
    const previous = {
      MEDIA_FETCHER: process.env.MEDIA_FETCHER,
      MEDIA_FETCHER_TOKEN_FILE: process.env.MEDIA_FETCHER_TOKEN_FILE,
    };
    process.env.MEDIA_FETCHER = '0';
    delete process.env.MEDIA_FETCHER_TOKEN_FILE;
    try {
      await expectFailClosed();
    } finally {
      restoreEnv(previous);
    }
  });

  it('fails closed without spawning ffmpeg when MEDIA_FETCHER=legacy', async () => {
    const previous = {
      MEDIA_FETCHER: process.env.MEDIA_FETCHER,
      MEDIA_FETCHER_TOKEN_FILE: process.env.MEDIA_FETCHER_TOKEN_FILE,
    };
    process.env.MEDIA_FETCHER = 'legacy';
    delete process.env.MEDIA_FETCHER_TOKEN_FILE;
    try {
      await expectFailClosed();
    } finally {
      restoreEnv(previous);
    }
  });

  it('fails closed for HLS URLs without using filename extensions as safety', async () => {
    const previous = {
      MEDIA_FETCHER: process.env.MEDIA_FETCHER,
      RADIO_ALLOW_HLS: process.env.RADIO_ALLOW_HLS,
      MEDIA_FETCHER_TOKEN_FILE: process.env.MEDIA_FETCHER_TOKEN_FILE,
    };
    delete process.env.MEDIA_FETCHER;
    process.env.RADIO_ALLOW_HLS = '0';
    delete process.env.MEDIA_FETCHER_TOKEN_FILE;
    try {
      await expectFailClosed('https://93.184.215.14/live.m3u8');
      await expectFailClosed('https://93.184.215.14/opaque');
    } finally {
      restoreEnv(previous);
    }
  });

  it('fails closed without spawning ffmpeg when MEDIA_EGRESS_PROXY=off', async () => {
    setMediaEgressProxyForTests(undefined);
    const previous = process.env.MEDIA_EGRESS_PROXY;
    process.env.MEDIA_EGRESS_PROXY = 'off';
    try {
      await expectFailClosed();
    } finally {
      if (previous === undefined) delete process.env.MEDIA_EGRESS_PROXY; else process.env.MEDIA_EGRESS_PROXY = previous;
      setMediaEgressProxyForTests(undefined);
    }
  });

  it('fails closed without spawning ffmpeg when the in-process proxy cannot be issued', async () => {
    setMediaEgressProxyForTests(undefined);
    const previous = { proxy: process.env.MEDIA_EGRESS_PROXY, upstream: process.env.MEDIA_UPSTREAM_PROXY };
    delete process.env.MEDIA_EGRESS_PROXY;
    process.env.MEDIA_UPSTREAM_PROXY = 'socks5://proxy:1080';
    try {
      await expectFailClosed();
    } finally {
      if (previous.proxy === undefined) delete process.env.MEDIA_EGRESS_PROXY; else process.env.MEDIA_EGRESS_PROXY = previous.proxy;
      if (previous.upstream === undefined) delete process.env.MEDIA_UPSTREAM_PROXY; else process.env.MEDIA_UPSTREAM_PROXY = previous.upstream;
      setMediaEgressProxyForTests(undefined);
    }
  });

  it('does not change the RadioStation schema', () => {
    const schema = fs.readFileSync(
      path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../prisma/schema.prisma'),
      'utf8',
    );
    assert.match(schema, /model RadioStation \{[\s\S]*?\n  url\s+String\n[\s\S]*?\n\}/);
    assert.equal(schema.includes('model RadioStation'), true);
  });

  it('fails closed without spawning ffmpeg when the fetcher socket is down', async () => {
    const previous = {
      MEDIA_FETCHER: process.env.MEDIA_FETCHER,
      MEDIA_FETCHER_SOCK: process.env.MEDIA_FETCHER_SOCK,
      MEDIA_FETCHER_TOKEN_FILE: process.env.MEDIA_FETCHER_TOKEN_FILE,
    };
    process.env.MEDIA_FETCHER = '1';
    process.env.MEDIA_FETCHER_SOCK = '/tmp/ts6-missing-jobs.sock';
    delete process.env.MEDIA_FETCHER_TOKEN_FILE;
    try {
      await expectFailClosed();
    } finally {
      restoreEnv(previous);
    }
  });
});
