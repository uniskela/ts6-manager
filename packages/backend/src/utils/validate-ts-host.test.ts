import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTsServerOrigin,
  sanitizeTsServerHost,
  validateTsServerPort,
} from './validate-ts-host.js';

describe('sanitizeTsServerHost', () => {
  it('accepts common TS deployment hosts', () => {
    assert.equal(sanitizeTsServerHost('127.0.0.1'), '127.0.0.1');
    assert.equal(sanitizeTsServerHost('teamspeak'), 'teamspeak');
    assert.equal(sanitizeTsServerHost('host.docker.internal'), 'host.docker.internal');
    assert.equal(sanitizeTsServerHost('ts.example.com'), 'ts.example.com');
  });

  it('normalizes bracketed IPv6 and trailing dots', () => {
    assert.equal(sanitizeTsServerHost('[::1]'), '::1');
    assert.equal(sanitizeTsServerHost('TS.EXAMPLE.COM.'), 'ts.example.com');
  });

  it('rejects URL tricks and metadata hosts', () => {
    assert.throws(() => sanitizeTsServerHost('http://evil.test'), /without URL path/);
    assert.throws(() => sanitizeTsServerHost('evil@test'), /without URL path/);
    assert.throws(() => sanitizeTsServerHost('169.254.169.254'), /not allowed/);
    assert.throws(() => sanitizeTsServerHost('metadata.google.internal'), /not allowed/);
  });
});

describe('validateTsServerPort', () => {
  it('accepts valid ports with fallback', () => {
    assert.equal(validateTsServerPort(10080, 10080), 10080);
    assert.equal(validateTsServerPort(undefined, 10022), 10022);
  });

  it('rejects invalid ports', () => {
    assert.throws(() => validateTsServerPort(0, 10080), /between 1 and 65535/);
    assert.throws(() => validateTsServerPort(70000, 10080), /between 1 and 65535/);
  });
});

describe('buildTsServerOrigin', () => {
  it('builds safe origins from validated parts', () => {
    assert.equal(buildTsServerOrigin('127.0.0.1', 10080, false), 'http://127.0.0.1:10080');
    assert.equal(buildTsServerOrigin('::1', 10080, true), 'https://[::1]:10080');
  });
});
