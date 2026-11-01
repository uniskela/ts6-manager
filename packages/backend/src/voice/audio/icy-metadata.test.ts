import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { fetchIcyMetadata } from './icy-metadata.js';

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { written: string; write: (chunk: string) => boolean; destroy: () => void };
  socket.written = '';
  socket.write = (chunk: string) => { socket.written += chunk; return true; };
  socket.destroy = () => { socket.emit('close'); };
  return socket;
}

describe('fetchIcyMetadata connection-time checks', () => {
  it('does not connect to a hostname that resolves only to private or metadata addresses', async () => {
    const connected: string[] = [];
    const deps = {
      resolve: async () => ['10.0.0.8', '169.254.169.254'],
      connect: async ({ host }) => {
        connected.push(host);
        throw new Error('must not connect');
      },
    };
    const title = await fetchIcyMetadata('https://radio.example/stream', 200, deps);
    assert.equal(title, null);
    assert.deepEqual(connected, []);
  });

  it('re-checks a redirect hop that names a private destination', async () => {
    const connected: string[] = [];
    const first = fakeSocket();
    const deps = {
      resolve: async (host) => (host === 'radio.example' ? ['93.184.215.14'] : ['169.254.169.254']),
      connect: async ({ host }) => {
        connected.push(host);
        if (host === '93.184.215.14') {
          setImmediate(() => {
            first.emit('data', Buffer.from(
              'HTTP/1.0 302 Found\r\nLocation: http://169.254.169.254/latest\r\n\r\n',
            ));
          });
          return first;
        }
        throw new Error('must not follow a private redirect');
      },
    };
    const title = await fetchIcyMetadata('http://radio.example/stream', 200, deps);
    assert.equal(title, null);
    assert.deepEqual(connected, ['93.184.215.14']);
  });

  it('connects to a pinned public address with Host and SNI from the URL, including Icecast ports', async () => {
    const first = fakeSocket();
    const seen: Array<{ host: string; port: number; tls: boolean; servername: string }> = [];
    const deps = {
      resolve: async () => ['10.0.0.8', '93.184.215.14'],
      connect: async (opts) => {
        seen.push(opts);
        setImmediate(() => first.emit('data', Buffer.from('HTTP/1.0 200 OK\r\n\r\n')));
        return first;
      },
    };
    await fetchIcyMetadata('https://radio.example:8443/live', 200, deps);
    assert.deepEqual(seen, [{ host: '93.184.215.14', port: 8443, tls: true, servername: 'radio.example' }]);
    assert.match(first.written, /Host: radio\.example:8443\r\n/);
    assert.doesNotMatch(first.written, /Host: 93\.184\.215\.14/);
  });

  it('connects to HTTP Icecast on port 8000 with the original Host header', async () => {
    const first = fakeSocket();
    const seen: Array<{ host: string; port: number; tls: boolean; servername: string }> = [];
    const deps = {
      resolve: async () => ['93.184.215.14'],
      connect: async (opts) => {
        seen.push(opts);
        setImmediate(() => first.emit('data', Buffer.from('ICY 200 OK\r\n\r\n')));
        return first;
      },
    };
    await fetchIcyMetadata('http://radio.example:8000/stream', 200, deps);
    assert.deepEqual(seen, [{ host: '93.184.215.14', port: 8000, tls: false, servername: 'radio.example' }]);
    assert.match(first.written, /Host: radio\.example:8000\r\n/);
  });

  it('does not follow a redirect to an unsupported protocol or port', async () => {
    const first = fakeSocket();
    let connects = 0;
    const deps = {
      resolve: async () => ['93.184.215.14'],
      connect: async ({ host }) => {
        connects += 1;
        if (host !== '93.184.215.14') throw new Error('must not follow');
        setImmediate(() => {
          first.emit('data', Buffer.from('HTTP/1.0 302 Found\r\nLocation: file:///etc/passwd\r\n\r\n'));
        });
        return first;
      },
    };
    assert.equal(await fetchIcyMetadata('http://radio.example/stream', 200, deps), null);
    assert.equal(connects, 1);
  });

  it('refuses non-HTTP protocols and ports outside the radio allowlist', async () => {
    let connects = 0;
    const deps = {
      resolve: async () => ['93.184.215.14'],
      connect: async () => {
        connects += 1;
        throw new Error('must not connect');
      },
    };
    assert.equal(await fetchIcyMetadata('file:///etc/passwd', 50, deps), null);
    assert.equal(await fetchIcyMetadata('https://radio.example:22/stream', 50, deps), null);
    assert.equal(connects, 0);
  });
});
