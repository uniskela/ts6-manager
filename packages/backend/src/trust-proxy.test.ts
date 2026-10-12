import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { applyTrustProxy, describeTrustProxy, forwardedHeaderWarning, parseTrustProxy } from './trust-proxy.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, '..');
const repoDir = resolve(here, '../../..');

function runFixture<T = Record<string, number>>(scenario: string, trustProxy?: string, argument?: string): T {
  const musicDir = mkdtempSync(resolve(tmpdir(), 'ts6-trust-proxy-'));
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'file:./data/trust-proxy-test.db', MUSIC_DIR: musicDir };
  delete env.TRUST_PROXY;
  if (trustProxy !== undefined) env.TRUST_PROXY = trustProxy;
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(here, 'trust-proxy.fixture.ts'), scenario, ...(argument === undefined ? [] : [argument])], {
      cwd: backendDir, env, encoding: 'utf8', timeout: 60_000,
    });
    const line = result.stdout.split('\n').find(l => l.startsWith('RESULT '));
    assert.ok(line, `fixture failed: ${result.stderr.slice(-500)}`);
    return JSON.parse(line.slice('RESULT '.length));
  } finally {
    rmSync(musicDir, { recursive: true, force: true });
  }
}

interface Burst { name: string; count: number; peer?: string; xff?: string; path?: string }

/** Run groups of requests in one backend process; returns the status codes of each group in order. */
function runBursts(trustProxy: string | undefined, bursts: Burst[]): Record<string, number[]> {
  return runFixture<Record<string, number[]>>('bursts', trustProxy, JSON.stringify(bursts));
}

/** The address the frontend container's nginx connects from. */
const PROXY = '172.18.0.3';
/** nginx forwards "<what the client sent>, <client address>". */
const viaProxy = (client: string, sent?: string) => ({ peer: PROXY, xff: sent ? `${sent}, ${client}` : client });
const limited = (statuses: number[]) => statuses.map(status => status === 429);

/** Evaluate the TRUST_PROXY default line of an image entrypoint with a given inherited env. */
function entrypointTrustProxy(script: string, inherited: string | undefined): string {
  const line = readFileSync(resolve(repoDir, 'docker-commands', script), 'utf8')
    .split('\n').find(l => l.startsWith('export TRUST_PROXY='));
  assert.ok(line, `${script} sets no TRUST_PROXY default`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  if (inherited !== undefined) env.TRUST_PROXY = inherited;
  const out = spawnSync('sh', ['-c', `${line}\nprintf %s "$TRUST_PROXY"`], { env, encoding: 'utf8' });
  return out.stdout;
}

describe('parseTrustProxy', () => {
  it('trusts nothing when unset or blank', () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy(' , '), false);
  });

  it('parses explicit lists, trimming entries', () => {
    assert.deepEqual(parseTrustProxy('loopback'), ['loopback']);
    assert.deepEqual(parseTrustProxy(' 10.0.0.0/8 , uniquelocal'), ['10.0.0.0/8', 'uniquelocal']);
  });

  it('accepts explicit none words, case-insensitively', () => {
    for (const word of ['false', 'none', 'off', 'no', 'NONE', 'False']) assert.equal(parseTrustProxy(word), false);
  });

  it('rejects mixing none with addresses', () => {
    assert.throws(() => parseTrustProxy('none,loopback'), /mixes/);
  });

  it('rejects boolean and hop-count values', () => {
    for (const value of ['true', '1', '2', 'loopback,3']) assert.throws(() => parseTrustProxy(value), /not supported/);
  });

  it('describes the effective setting for the startup log', () => {
    assert.match(describeTrustProxy(false), /none/);
    assert.equal(describeTrustProxy(['loopback', '10.0.0.0/8']), 'loopback, 10.0.0.0/8');
    assert.match(describeTrustProxy('private-peer'), /^private-peer \(one hop, only when the connecting peer has a private address\)$/);
  });

  it('parses private-peer on its own and rejects mixing it with addresses', () => {
    assert.equal(parseTrustProxy('private-peer'), 'private-peer');
    assert.equal(parseTrustProxy(' Private-Peer '), 'private-peer');
    assert.throws(() => parseTrustProxy('private-peer,10.0.0.0/8'), /mixes "private-peer"/);
    assert.throws(() => parseTrustProxy('loopback,private-peer'), /mixes "private-peer"/);
  });

  it('hands explicit settings to Express unchanged', () => {
    const none = express();
    applyTrustProxy(none, false);
    assert.equal(none.get('trust proxy'), false);
    const list = ['uniquelocal', '203.0.113.7'];
    const explicit = express();
    applyTrustProxy(explicit, list);
    assert.equal(explicit.get('trust proxy'), list);
  });

  it('private-peer trusts a private socket peer and nothing further left', () => {
    const app = express();
    applyTrustProxy(app, 'private-peer');
    const trust = app.get('trust proxy fn') as (addr: string, hop: number) => boolean;
    for (const addr of ['10.1.2.3', '172.18.0.3', '::ffff:172.18.0.3', '192.168.1.9', 'fd00::5']) {
      assert.equal(trust(addr, 0), true, `peer ${addr}`);
      assert.equal(trust(addr, 1), false, `forwarded entry ${addr}`);
    }
    for (const addr of ['127.0.0.1', '::1', '8.8.8.8', '::ffff:203.0.113.7', '2001:db8::1']) assert.equal(trust(addr, 0), false, addr);
  });

  it('private-peer makes req.ip the right-most forwarded entry, and only behind a private peer', () => {
    const app = express();
    applyTrustProxy(app, 'private-peer');
    const ipFor = (peer: string, xff?: string) => {
      const req = Object.create(app.request) as express.Request;
      Object.assign(req, { app, socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
      return req.ip;
    };
    assert.equal(ipFor('172.18.0.3', '198.51.100.10'), '198.51.100.10');
    assert.equal(ipFor('172.18.0.3', '203.0.113.9, 192.168.1.50'), '192.168.1.50');
    assert.equal(ipFor('172.18.0.3', '203.0.113.9, 10.0.0.7, 172.18.0.10'), '172.18.0.10');
    assert.equal(ipFor('172.18.0.3'), '172.18.0.3');
    assert.equal(ipFor('198.51.100.40', '203.0.113.9'), '198.51.100.40');
    assert.equal(ipFor('127.0.0.1', '203.0.113.9'), '127.0.0.1');
  });
});

describe('image entrypoint defaults', () => {
  it('all-in-one defaults to loopback only', () => {
    assert.equal(entrypointTrustProxy('start-backend.sh', undefined), 'loopback');
    assert.equal(entrypointTrustProxy('start-backend.sh', ''), 'loopback');
  });

  it('split backend image defaults to one private hop', () => {
    assert.equal(entrypointTrustProxy('start-backend-standalone.sh', undefined), 'private-peer');
    assert.equal(entrypointTrustProxy('start-backend-standalone.sh', ''), 'private-peer');
  });

  it('an explicit TRUST_PROXY always wins, including "none"', () => {
    for (const script of ['start-backend.sh', 'start-backend-standalone.sh']) {
      assert.equal(entrypointTrustProxy(script, '172.18.0.0/16'), '172.18.0.0/16');
      assert.equal(entrypointTrustProxy(script, 'none'), 'none');
      assert.equal(entrypointTrustProxy(script, 'false'), 'false');
    }
  });

  it('uniquelocal trusts private peers but never public ones', () => {
    const app = express();
    app.set('trust proxy', parseTrustProxy('uniquelocal'));
    const trust = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
    for (const addr of ['10.1.2.3', '172.18.0.5', '192.168.1.9', 'fd00::5']) assert.equal(trust(addr, 0), true, addr);
    for (const addr of ['8.8.8.8', '203.0.113.7', '2001:db8::1']) assert.equal(trust(addr, 0), false, addr);
  });
});

describe('forwardedHeaderWarning', () => {
  const run = (setting: false | string[], headers: Record<string, string>, times = 3) => {
    const messages: string[] = [];
    const mw = forwardedHeaderWarning(setting, m => messages.push(m));
    for (let i = 0; i < times; i++) mw({ headers } as never, {} as never, () => undefined);
    return messages;
  };

  it('warns once when a forwarded header arrives and nothing is trusted, without echoing it', () => {
    const messages = run(false, { 'x-forwarded-for': '198.51.100.77' });
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0], /198\.51\.100\.77/);
  });

  it('stays quiet without the header or when a proxy is trusted', () => {
    assert.equal(run(false, {}).length, 0);
    assert.equal(run(['loopback'], { 'x-forwarded-for': '198.51.100.77' }).length, 0);
  });
});

describe('login limiter keying through createApp', { timeout: 120_000 }, () => {
  it('REPRODUCTION: with nothing trusted (the 1.11.0 stock result) two clients behind nginx share one bucket', () => {
    const result = runFixture('two-clients', undefined);
    assert.equal(result.clientA16th, 429);
    assert.equal(result.clientB1st, 429, 'client B is locked out by client A');
  });

  it('all-in-one default (loopback): two clients behind nginx get separate buckets', () => {
    const result = runFixture('two-clients', 'loopback');
    assert.equal(result.clientA16th, 429);
    assert.notEqual(result.clientB1st, 429);
  });

  it('all-in-one default (loopback): a forged left-most entry cannot pick the bucket', () => {
    assert.equal(runFixture('rotating-forged-header', 'loopback').forged16th, 429);
  });

  it('trust nothing (none): a direct client cannot pick its bucket with a forged header', () => {
    assert.equal(runFixture('direct-rotating-header', 'none').forged16th, 429);
    assert.equal(runFixture('direct-rotating-header', undefined).forged16th, 429);
  });
});

describe('split image default behind the bundled frontend proxy', { timeout: 240_000 }, () => {
  const splitDefault = () => entrypointTrustProxy('start-backend-standalone.sh', undefined);
  const rotating = '203.0.113.{i}';

  it('keys every client on the address the proxy observed, whatever the client sends', () => {
    const result = runBursts(splitDefault(), [
      { name: 'publicA', count: 16, ...viaProxy('198.51.100.10') },
      { name: 'publicB', count: 1, ...viaProxy('198.51.100.20') },
      { name: 'publicForging', count: 16, ...viaProxy('198.51.100.30', rotating) },
      // A client on the compose network, or one Docker presents under the bridge address.
      { name: 'composeForging', count: 16, ...viaProxy('172.18.0.10', rotating) },
      // A LAN client uses up its attempts, then starts forging.
      { name: 'lanPlain', count: 16, ...viaProxy('192.168.1.50') },
      { name: 'lanForging', count: 5, ...viaProxy('192.168.1.50', rotating) },
      { name: 'privateA', count: 16, ...viaProxy('10.0.0.5') },
      { name: 'privateB', count: 1, ...viaProxy('10.0.0.6') },
    ]);
    const sixteenth = [...Array<boolean>(15).fill(false), true];
    assert.deepEqual(limited(result.publicA), sixteenth, 'a public client is limited on its own address');
    assert.deepEqual(limited(result.publicB), [false], 'another public client has its own bucket');
    assert.deepEqual(limited(result.publicForging), sixteenth, 'a public client cannot pick its bucket');
    assert.deepEqual(limited(result.composeForging), sixteenth, 'a private client cannot pick its bucket');
    assert.deepEqual(limited(result.lanPlain), sixteenth);
    assert.deepEqual(limited(result.lanForging), Array<boolean>(5).fill(true), 'a limited private client cannot escape by forging');
    assert.deepEqual(limited(result.privateA), sixteenth);
    assert.deepEqual(limited(result.privateB), [false], 'two private clients get separate buckets');
  });

  it('applies the same client address to the listener remote exchange limit', () => {
    const result = runBursts(splitDefault(), [
      { name: 'forging', count: 12, path: '/api/listener-remote/exchange', ...viaProxy('192.168.1.60', rotating) },
      { name: 'other', count: 1, path: '/api/listener-remote/exchange', ...viaProxy('192.168.1.61') },
    ]);
    assert.deepEqual(limited(result.forging), [...Array<boolean>(10).fill(false), true, true]);
    assert.deepEqual(limited(result.other), [false]);
  });

  it('ignores the header of a public peer that connects to the backend directly', () => {
    const result = runBursts(splitDefault(), [{ name: 'direct', count: 16, peer: '198.51.100.40', xff: rotating }]);
    assert.deepEqual(limited(result.direct), [...Array<boolean>(15).fill(false), true]);
  });

  it('RESIDUAL: a private peer that connects to the backend directly is taken for the proxy', () => {
    // Its right-most X-Forwarded-For entry becomes the client address, so it can still
    // choose its bucket. Keeping port 3001 unpublished is what closes this.
    const result = runBursts(splitDefault(), [
      { name: 'forging', count: 20, peer: '172.18.0.11', xff: rotating },
      { name: 'fixedEntry', count: 16, peer: '172.18.0.11', xff: '203.0.113.200, 198.51.100.77' },
      { name: 'realOwner', count: 1, ...viaProxy('198.51.100.77') },
    ]);
    assert.deepEqual(limited(result.forging), Array<boolean>(20).fill(false));
    assert.deepEqual(limited(result.fixedEntry), [...Array<boolean>(15).fill(false), true], 'keyed on the last entry it sent');
    assert.deepEqual(limited(result.realOwner), [true], 'and that is the bucket of whoever owns that address');
  });

  it('an outer proxy on a private address is one bucket until TRUST_PROXY names it', () => {
    // client -> outer proxy 10.0.0.2 -> frontend nginx -> backend: "<client>, 10.0.0.2".
    const bursts: Burst[] = [
      { name: 'clientA', count: 16, peer: PROXY, xff: '198.51.100.50, 10.0.0.2' },
      { name: 'clientB', count: 1, peer: PROXY, xff: '198.51.100.51, 10.0.0.2' },
    ];
    assert.deepEqual(limited(runBursts(splitDefault(), bursts).clientB), [true], 'default: both are the outer proxy');
    for (const explicit of ['uniquelocal', '172.18.0.0/16,10.0.0.2']) {
      const result = runBursts(explicit, bursts);
      assert.deepEqual(limited(result.clientA), [...Array<boolean>(15).fill(false), true], explicit);
      assert.deepEqual(limited(result.clientB), [false], explicit);
    }
  });

  it('an explicit uniquelocal keeps trusting every private hop, as before', () => {
    const result = runBursts('uniquelocal', [{ name: 'forging', count: 20, ...viaProxy('192.168.1.50', rotating) }]);
    assert.deepEqual(limited(result.forging), Array<boolean>(20).fill(false));
  });
});
