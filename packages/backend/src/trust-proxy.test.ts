import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describeTrustProxy, forwardedHeaderWarning, parseTrustProxy } from './trust-proxy.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, '..');
const repoDir = resolve(here, '../../..');

function runFixture(scenario: string, trustProxy?: string): Record<string, number> {
  const musicDir = mkdtempSync(resolve(tmpdir(), 'ts6-trust-proxy-'));
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'file:./data/trust-proxy-test.db', MUSIC_DIR: musicDir };
  delete env.TRUST_PROXY;
  if (trustProxy !== undefined) env.TRUST_PROXY = trustProxy;
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(here, 'trust-proxy.fixture.ts'), scenario], {
      cwd: backendDir, env, encoding: 'utf8', timeout: 60_000,
    });
    const line = result.stdout.split('\n').find(l => l.startsWith('RESULT '));
    assert.ok(line, `fixture failed: ${result.stderr.slice(-500)}`);
    return JSON.parse(line.slice('RESULT '.length));
  } finally {
    rmSync(musicDir, { recursive: true, force: true });
  }
}

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
  });
});

describe('image entrypoint defaults', () => {
  it('all-in-one defaults to loopback only', () => {
    assert.equal(entrypointTrustProxy('start-backend.sh', undefined), 'loopback');
    assert.equal(entrypointTrustProxy('start-backend.sh', ''), 'loopback');
  });

  it('split backend image defaults to private ranges only', () => {
    assert.equal(entrypointTrustProxy('start-backend-standalone.sh', undefined), 'uniquelocal');
    assert.equal(entrypointTrustProxy('start-backend-standalone.sh', ''), 'uniquelocal');
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
