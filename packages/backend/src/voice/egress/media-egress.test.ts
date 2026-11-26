import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  acquireMediaEgress,
  egressEnvironment,
  ignoredProxyVariables,
  MEDIA_EGRESS_OFF_REFUSAL,
  MediaEgressError,
  mediaEgressEnabled,
  parseUpstreamProxy,
  setMediaEgressProxyForTests,
  startMediaEgress,
} from './media-egress.js';

const saved = { off: process.env.MEDIA_EGRESS_PROXY, upstream: process.env.MEDIA_UPSTREAM_PROXY };

afterEach(() => {
  setMediaEgressProxyForTests(undefined);
  if (saved.off === undefined) delete process.env.MEDIA_EGRESS_PROXY; else process.env.MEDIA_EGRESS_PROXY = saved.off;
  if (saved.upstream === undefined) delete process.env.MEDIA_UPSTREAM_PROXY; else process.env.MEDIA_UPSTREAM_PROXY = saved.upstream;
});

describe('media egress settings', () => {
  it('is on unless explicitly switched off', () => {
    assert.equal(mediaEgressEnabled({}), true);
    assert.equal(mediaEgressEnabled({ MEDIA_EGRESS_PROXY: 'on' }), true);
    assert.equal(mediaEgressEnabled({ MEDIA_EGRESS_PROXY: 'false' }), true, 'only "off" disables it');
    assert.equal(mediaEgressEnabled({ MEDIA_EGRESS_PROXY: ' OFF ' }), false);
  });

  it('gives child processes only the job proxy', () => {
    const env = egressEnvironment('http://job:t@127.0.0.1:1', {
      PATH: '/usr/bin', HTTP_PROXY: 'http://corp:3128', https_proxy: 'x', ALL_PROXY: 'socks5://x', all_proxy: 'x',
      NO_PROXY: '*', no_proxy: '*', No_Proxy: '*', FTP_PROXY: 'x', MEDIA_UPSTREAM_PROXY: 'http://user:pw@corp:3128',
    });
    assert.deepEqual(env, {
      PATH: '/usr/bin',
      http_proxy: 'http://job:t@127.0.0.1:1', https_proxy: 'http://job:t@127.0.0.1:1',
      HTTP_PROXY: 'http://job:t@127.0.0.1:1', HTTPS_PROXY: 'http://job:t@127.0.0.1:1',
    });
  });

  it('reads the upstream proxy and rejects anything but http://host:port', () => {
    assert.equal(parseUpstreamProxy(undefined), undefined);
    assert.equal(parseUpstreamProxy(' '), undefined);
    assert.deepEqual(parseUpstreamProxy('http://proxy.corp:3128'), { host: 'proxy.corp', port: 3128, authorization: undefined });
    assert.deepEqual(parseUpstreamProxy('http://u%40x:p%3Aw@[2001:db8::1]:8080'), {
      host: '2001:db8::1', port: 8080, authorization: `Basic ${Buffer.from('u@x:p:w').toString('base64')}`,
    });
    for (const bad of ['socks5://proxy:1080', 'https://proxy:3128', 'proxy:3128', 'http://proxy:3128/path']) {
      assert.throws(() => parseUpstreamProxy(bad), /MEDIA_UPSTREAM_PROXY/, bad);
    }
  });

  it('names proxy variables that media jobs ignore', () => {
    assert.deepEqual(ignoredProxyVariables({ HTTP_PROXY: 'x', no_proxy: 'y', MEDIA_EGRESS_PROXY: 'on', PATH: '/' }).sort(), ['HTTP_PROXY', 'no_proxy']);
  });

  it('does not treat the image TRUST_PROXY default as an unused outbound proxy', () => {
    for (const trust of ['loopback', 'private-peer']) {
      assert.deepEqual(
        ignoredProxyVariables({
          TRUST_PROXY: trust,
          SIDECAR_URL: 'http://127.0.0.1:9800',
          SIDECAR_EGRESS_PROXY: 'on',
          MEDIA_EGRESS_PROXY: 'on',
        }),
        [],
        trust,
      );
    }
  });
});

describe('media egress jobs', () => {
  it('issues and revokes a token per job', async () => {
    delete process.env.MEDIA_EGRESS_PROXY;
    delete process.env.MEDIA_UPSTREAM_PROXY;
    const job = await acquireMediaEgress('https://media.test/a.mp3', 60_000);
    assert.ok(job);
    assert.match(job.proxyUrl, /^http:\/\/job:[0-9a-f]{64}@127\.0\.0\.1:\d+$/);
    job.release();
    job.release();
  });

  it('fails closed when the upstream proxy setting is invalid', async () => {
    delete process.env.MEDIA_EGRESS_PROXY;
    process.env.MEDIA_UPSTREAM_PROXY = 'socks5://proxy:1080';
    await assert.rejects(acquireMediaEgress('https://media.test/a.mp3', 60_000), MediaEgressError);
    const warnings: string[] = [];
    await startMediaEgress({ log: () => {}, warn: (m: string) => warnings.push(m) });
    assert.ok(warnings.some((w) => w.includes('unavailable')));
    assert.ok(warnings.every((w) => !w.includes('socks5://proxy')), 'the setting value is not logged');
  });

  it('accepts only YouTube links and searches while switched off', async () => {
    process.env.MEDIA_EGRESS_PROXY = 'off';
    assert.equal(await acquireMediaEgress('https://www.youtube.com/watch?v=abcdefghijk', 60_000), null);
    assert.equal(await acquireMediaEgress('https://youtu.be/abcdefghijk', 60_000), null);
    assert.equal(await acquireMediaEgress('https://music.youtube.com/search?q=x#songs', 60_000), null);
    assert.equal(await acquireMediaEgress('ytsearch1:artist title', 60_000), null);
    for (const target of [
      'https://soundcloud.com/a/b', 'http://www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com.evil.test/x',
      'https://user:pw@www.youtube.com/watch?v=abcdefghijk', 'not a url',
    ]) {
      await assert.rejects(acquireMediaEgress(target, 60_000), (err: Error) => err instanceof MediaEgressError && err.message === MEDIA_EGRESS_OFF_REFUSAL, target);
    }
    const warnings: string[] = [];
    await startMediaEgress({ log: () => {}, warn: (m: string) => warnings.push(m) });
    assert.match(warnings.join('\n'), /DISABLED by MEDIA_EGRESS_PROXY=off/);
  });

  it('starts cleanly with the container TRUST_PROXY default', async () => {
    delete process.env.MEDIA_EGRESS_PROXY;
    delete process.env.MEDIA_UPSTREAM_PROXY;
    const before = { trust: process.env.TRUST_PROXY, https: process.env.HTTPS_PROXY, http: process.env.HTTP_PROXY };
    process.env.TRUST_PROXY = 'loopback';
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    try {
      const warnings: string[] = [];
      const logs: string[] = [];
      await startMediaEgress({ log: (m: string) => logs.push(m), warn: (m: string) => warnings.push(m) });
      assert.deepEqual(warnings, []);
      assert.deepEqual(logs, ['[MediaEgress] enforcing (upstream: none)']);
    } finally {
      if (before.trust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = before.trust;
      if (before.https === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = before.https;
      if (before.http === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = before.http;
    }
  });

  it('warns at start-up about proxy variables it no longer uses', async () => {
    delete process.env.MEDIA_EGRESS_PROXY;
    delete process.env.MEDIA_UPSTREAM_PROXY;
    const before = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://user:secret@corp:3128';
    try {
      const warnings: string[] = [];
      const logs: string[] = [];
      await startMediaEgress({ log: (m: string) => logs.push(m), warn: (m: string) => warnings.push(m) });
      assert.match(warnings.join('\n'), /HTTPS_PROXY is set but media downloads no longer use it/);
      assert.ok(!warnings.join('\n').includes('secret'));
      assert.deepEqual(logs, ['[MediaEgress] enforcing (upstream: none)']);
    } finally {
      if (before === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = before;
    }
  });
});
