import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_LOCATION_LENGTH,
  REDIRECT_STATUSES,
  buildClientResponseHeaders,
  sanitizeRedirectLocation,
} from './response-headers.mjs';

describe('sanitizeRedirectLocation', () => {
  it('accepts absolute http(s) without credentials', () => {
    assert.equal(
      sanitizeRedirectLocation('http://203.0.113.10:8000/live'),
      'http://203.0.113.10:8000/live',
    );
    assert.equal(
      sanitizeRedirectLocation('https://cdn.example/a.mp3'),
      'https://cdn.example/a.mp3',
    );
  });

  it('accepts relative references', () => {
    assert.equal(sanitizeRedirectLocation('/stream'), '/stream');
    assert.equal(sanitizeRedirectLocation('live?x=1'), 'live?x=1');
    assert.equal(sanitizeRedirectLocation('../alt'), '../alt');
  });

  it('rejects protocol-relative, credentials, other schemes, controls, and oversize', () => {
    assert.equal(sanitizeRedirectLocation('//evil.example/x'), null);
    assert.equal(sanitizeRedirectLocation('http://u:p@host/x'), null);
    assert.equal(sanitizeRedirectLocation('file:///etc/passwd'), null);
    assert.equal(sanitizeRedirectLocation('javascript:alert(1)'), null);
    assert.equal(sanitizeRedirectLocation('http://host/x\r\nSet-Cookie: a=b'), null);
    assert.equal(sanitizeRedirectLocation(`http://h/${'a'.repeat(MAX_LOCATION_LENGTH)}`), null);
    assert.equal(sanitizeRedirectLocation(''), null);
    assert.equal(sanitizeRedirectLocation(null), null);
    assert.equal(sanitizeRedirectLocation(['http://ok/', 'http://second/']), 'http://ok/');
  });
});

describe('buildClientResponseHeaders', () => {
  it('forwards Location only on redirect statuses', () => {
    for (const status of REDIRECT_STATUSES) {
      const headers = buildClientResponseHeaders({
        statusCode: status,
        headers: {
          'content-type': 'audio/mpeg',
          location: 'http://203.0.113.10/next',
          'set-cookie': 'secret=1',
          server: 'icecast',
        },
      });
      assert.equal(headers.location, 'http://203.0.113.10/next');
      assert.equal(headers['content-type'], 'audio/mpeg');
      assert.equal(headers.connection, 'close');
      assert.equal(headers['set-cookie'], undefined);
      assert.equal(headers.server, undefined);
    }
  });

  it('omits Location for non-redirects and for bad Location values', () => {
    assert.equal(
      buildClientResponseHeaders({
        statusCode: 200,
        headers: { location: 'http://203.0.113.10/x', 'content-type': 'audio/mpeg' },
      }).location,
      undefined,
    );
    assert.equal(
      buildClientResponseHeaders({
        statusCode: 302,
        headers: { location: 'file:///etc/passwd' },
      }).location,
      undefined,
    );
    assert.equal(
      buildClientResponseHeaders({
        statusCode: 302,
        headers: {},
      }).location,
      undefined,
    );
  });
});
