import assert from 'node:assert/strict';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { describe, it } from 'node:test';
import { connectIcySocket, fetchIcyMetadata } from './icy-metadata.js';

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { written: string; write: (chunk: string) => boolean; destroy: () => void };
  socket.written = '';
  socket.write = (chunk: string) => { socket.written += chunk; return true; };
  socket.destroy = () => { socket.emit('close'); };
  return socket;
}

function connectionsOf(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((err, count) => err ? reject(err) : resolve(count));
  });
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

  it('refuses mixed public and private IPv4 or IPv6 answers', async () => {
    const connected: string[] = [];
    const deps = {
      resolve: async () => ['93.184.215.14', '10.0.0.8'],
      connect: async ({ host }) => {
        connected.push(host);
        throw new Error('must not connect');
      },
    };
    assert.equal(await fetchIcyMetadata('https://radio.example/stream', 80, deps), null);
    assert.deepEqual(connected, []);
    const v6 = {
      resolve: async () => ['2606:4700::1', '::ffff:10.0.0.1'],
      connect: async ({ host }) => {
        connected.push(host);
        throw new Error('must not connect');
      },
    };
    assert.equal(await fetchIcyMetadata('https://radio.example/stream', 80, v6), null);
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
      resolve: async () => ['93.184.215.14'],
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
    assert.match(first.written, /Host: radio.example:8000\r\n/);
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

  it('does not start ICY when MEDIA_EGRESS_PROXY=off', async () => {
    const previous = process.env.MEDIA_EGRESS_PROXY;
    process.env.MEDIA_EGRESS_PROXY = 'off';
    let connects = 0;
    try {
      assert.equal(await fetchIcyMetadata('https://radio.example/stream', 80, {
        resolve: async () => ['93.184.215.14'],
        connect: async () => {
          connects += 1;
          throw new Error('must not connect');
        },
      }), null);
      assert.equal(connects, 0);
    } finally {
      if (previous === undefined) delete process.env.MEDIA_EGRESS_PROXY;
      else process.env.MEDIA_EGRESS_PROXY = previous;
    }
  });

  it('aborts a hanging ICY DNS lookup without connecting', async () => {
    let aborted = false;
    let connects = 0;
    const title = await fetchIcyMetadata('https://radio.example/stream', 40, {
      resolve: (_host, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('cancelled'));
        }, { once: true });
      }),
      connect: async () => {
        connects += 1;
        throw new Error('must not connect');
      },
    });
    assert.equal(title, null);
    assert.equal(aborted, true);
    assert.equal(connects, 0);
  });

  it('destroys a pending TLS handshake when the ICY timeout fires', async () => {
    let incoming: net.Socket | undefined;
    const silent = net.createServer((socket) => {
      incoming = socket;
      socket.resume();
    });
    silent.listen(0, '127.0.0.1');
    await once(silent, 'listening');
    const port = (silent.address() as net.AddressInfo).port;
    try {
      const title = await fetchIcyMetadata('https://radio.example/stream', 80, {
        resolve: async () => ['93.184.215.14'],
        connect: (opts, signal) => connectIcySocket({
          host: '127.0.0.1',
          port,
          tls: true,
          servername: opts.servername,
        }, signal),
      });
      assert.equal(title, null);
      assert.ok(incoming, 'the TLS client connected');
      for (let i = 0; i < 30 && !incoming.destroyed; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(incoming.destroyed, true);
      assert.equal(await connectionsOf(silent), 0);
    } finally {
      incoming?.destroy();
      silent.close();
    }
  });
});
