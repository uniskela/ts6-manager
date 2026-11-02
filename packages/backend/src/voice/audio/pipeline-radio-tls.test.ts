import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RADIO_EGRESS_PORTS } from '../egress/egress-policy.js';
import { MediaEgressProxy } from '../egress/media-egress-proxy.js';
import { egressEnvironment } from '../egress/media-egress.js';
import { buildPcmStreamArgs } from './pipeline.js';

const ffmpegVersion = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' });
const haveFfmpeg = !ffmpegVersion.error && ffmpegVersion.status === 0;
const ffmpegBanner = `${ffmpegVersion.stdout ?? ''}\n${ffmpegVersion.stderr ?? ''}`;

function runFfmpeg(args: string[], env?: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (status: number | null, stderr: string) => {
      if (settled) return;
      settled = true;
      resolve({ status, stderr });
    };
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
      env: env ?? process.env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout?.resume();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(251, stderr || 'timed out');
    }, 8_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      done(status, stderr);
    });
  });
}

/** Decode a short HTTPS/HTTP radio URL without reconnect retries that hide TLS failures. */
function tlsProbeArgs(input: string, extra: string[] = []): string[] {
  return [
    '-protocol_whitelist', 'http,https,tls,tcp,httpproxy,crypto',
    '-tls_verify', '1',
    ...extra,
    '-i', input,
    '-t', '0.15',
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '2',
    '-loglevel', 'error',
    '-y', join(tmpdir(), `ts6-radio-out-${process.pid}.pcm`),
  ];
}

function openssl(args: string[]) {
  const result = spawnSync('openssl', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'openssl failed');
  return result;
}

describe('real ffmpeg radio TLS verification', { skip: !haveFfmpeg }, () => {
  it('records the local ffmpeg TLS build', () => {
    assert.match(ffmpegBanner, /ffmpeg version /);
    assert.match(ffmpegBanner, /--enable-gnutls|--enable-openssl|--enable-libtls|--enable-mbedtls/);
  });

  it('rejects untrusted and hostname-mismatched certificates and accepts a trusted match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ts6-radio-tls-'));
    try {
      openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'),
        '-days', '1', '-nodes', '-subj', '/CN=TS6-Test-CA']);
      await writeFile(join(dir, 'match.cnf'), 'subjectAltName=IP:127.0.0.1\n');
      await writeFile(join(dir, 'mismatch.cnf'), 'subjectAltName=DNS:radio.test\n');
      openssl(['req', '-newkey', 'rsa:2048', '-keyout', join(dir, 'match.key'), '-out', join(dir, 'match.csr'),
        '-nodes', '-subj', '/CN=127.0.0.1']);
      openssl(['x509', '-req', '-in', join(dir, 'match.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'),
        '-out', join(dir, 'match.crt'), '-days', '1', '-CAcreateserial', '-extfile', join(dir, 'match.cnf')]);
      openssl(['req', '-newkey', 'rsa:2048', '-keyout', join(dir, 'bad.key'), '-out', join(dir, 'bad.csr'),
        '-nodes', '-subj', '/CN=radio.test']);
      openssl(['x509', '-req', '-in', join(dir, 'bad.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'),
        '-out', join(dir, 'bad.crt'), '-days', '1', '-CAcreateserial', '-extfile', join(dir, 'mismatch.cnf')]);

      const mp3 = join(dir, 'tone.mp3');
      const made = spawnSync('ffmpeg', ['-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-q:a', '9', '-y', mp3], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
      const body = await readFile(mp3);

      const listen = async (cert: string, key: string) => {
        const server = https.createServer({
          cert: await readFile(join(dir, cert)),
          key: await readFile(join(dir, key)),
        }, (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          res.end(body);
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        return server;
      };

      const trusted = await listen('match.crt', 'match.key');
      const trustedPort = (trusted.address() as import('node:net').AddressInfo).port;
      const mismatched = await listen('bad.crt', 'bad.key');
      const mismatchPort = (mismatched.address() as import('node:net').AddressInfo).port;
      try {
        const untrusted = await runFfmpeg(tlsProbeArgs(`https://127.0.0.1:${trustedPort}/tone.mp3`));
        assert.notEqual(untrusted.status, 0, untrusted.stderr || 'self-signed without a CA must fail');

        const mismatch = await runFfmpeg(tlsProbeArgs(`https://127.0.0.1:${mismatchPort}/tone.mp3`, [
          '-ca_file', join(dir, 'ca.crt'),
        ]));
        assert.notEqual(mismatch.status, 0, mismatch.stderr || 'hostname mismatch must fail');

        const ok = await runFfmpeg(tlsProbeArgs(`https://127.0.0.1:${trustedPort}/tone.mp3`, [
          '-ca_file', join(dir, 'ca.crt'),
        ]));
        assert.equal(ok.status, 0, ok.stderr);
      } finally {
        trusted.close();
        mismatched.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fetches an HTTPS HLS playlist and segment through the checked proxy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ts6-radio-hls-'));
    const pinned: string[] = [];
    const proxy = new MediaEgressProxy({
      permitAddress: (address) => {
        pinned.push(address);
        return address === '127.0.0.1';
      },
      permitPort: () => true,
      resolve: async () => ['127.0.0.1'],
      log: () => {},
    });
    try {
      openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'),
        '-days', '1', '-nodes', '-subj', '/CN=TS6-Test-CA']);
      await writeFile(join(dir, 'match.cnf'), 'subjectAltName=IP:127.0.0.1\n');
      openssl(['req', '-newkey', 'rsa:2048', '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.csr'),
        '-nodes', '-subj', '/CN=127.0.0.1']);
      openssl(['x509', '-req', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'),
        '-out', join(dir, 'server.crt'), '-days', '1', '-CAcreateserial', '-extfile', join(dir, 'match.cnf')]);

      const ts = join(dir, 'seg.ts');
      const made = spawnSync('ffmpeg', ['-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
        '-c:a', 'aac', '-f', 'mpegts', '-y', ts], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
      const key = Buffer.alloc(16, 0x11);
      const iv = Buffer.alloc(16, 0);
      await writeFile(join(dir, 'plain.ts'), await readFile(ts));
      openssl(['enc', '-aes-128-cbc', '-in', join(dir, 'plain.ts'), '-out', join(dir, 'seg.enc'),
        '-K', key.toString('hex'), '-iv', iv.toString('hex')]);
      const encrypted = await readFile(join(dir, 'seg.enc'));
      const hits: string[] = [];

      const server = https.createServer({
        cert: await readFile(join(dir, 'server.crt')),
        key: await readFile(join(dir, 'server.key')),
      }, (req, res) => {
        hits.push(req.url ?? '');
        if (req.url?.startsWith('/live.m3u8')) {
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
          res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000\n#EXTINF:0.4,\nseg.ts\n#EXT-X-ENDLIST\n');
          return;
        }
        if (req.url?.startsWith('/key.bin')) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(key);
          return;
        }
        if (req.url?.startsWith('/seg.ts')) {
          res.writeHead(200, { 'Content-Type': 'video/mp2t' });
          res.end(encrypted);
          return;
        }
        res.writeHead(404).end();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as import('node:net').AddressInfo).port;
      const job = await proxy.issue(60_000, { ports: RADIO_EGRESS_PORTS });
      const url = `https://127.0.0.1:${port}/live.m3u8`;
      const result = await runFfmpeg(
        tlsProbeArgs(url, [
          '-format_whitelist', 'hls,mpegts,mp3',
          '-allowed_extensions', 'ALL',
          '-ca_file', join(dir, 'ca.crt'),
        ]),
        egressEnvironment(job.proxyUrl),
      );
      job.release();
      server.close();
      assert.ok(hits.some((path) => path.startsWith('/live.m3u8')), `${result.stderr} hits=${hits.join(',')}`);
      assert.ok(hits.some((path) => path.startsWith('/key.bin')), `${result.stderr} hits=${hits.join(',')}`);
      assert.ok(hits.some((path) => path.startsWith('/seg.ts')), `${result.stderr} hits=${hits.join(',')}`);
      assert.ok(pinned.length >= 3, `nested hops must be pinned by the proxy (${pinned.length}): ${result.stderr}`);
    } finally {
      await proxy.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not fetch HLS hops when the proxy refuses the destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ts6-radio-hls-refuse-'));
    const proxy = new MediaEgressProxy({
      permitAddress: () => false,
      permitPort: () => true,
      resolve: async () => ['127.0.0.1'],
      log: () => {},
    });
    try {
      openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'),
        '-days', '1', '-nodes', '-subj', '/CN=TS6-Test-CA']);
      await writeFile(join(dir, 'match.cnf'), 'subjectAltName=IP:127.0.0.1\n');
      openssl(['req', '-newkey', 'rsa:2048', '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.csr'),
        '-nodes', '-subj', '/CN=127.0.0.1']);
      openssl(['x509', '-req', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'),
        '-out', join(dir, 'server.crt'), '-days', '1', '-CAcreateserial', '-extfile', join(dir, 'match.cnf')]);
      const hits: string[] = [];
      const server = https.createServer({
        cert: await readFile(join(dir, 'server.crt')),
        key: await readFile(join(dir, 'server.key')),
      }, (req, res) => {
        hits.push(req.url ?? '');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.4,\nseg.ts\n#EXT-X-ENDLIST\n');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as import('node:net').AddressInfo).port;
      const job = await proxy.issue(60_000, { ports: RADIO_EGRESS_PORTS });
      await runFfmpeg(
        tlsProbeArgs(`https://127.0.0.1:${port}/live.m3u8`, [
          '-format_whitelist', 'hls,mpegts,mp3',
          '-ca_file', join(dir, 'ca.crt'),
        ]),
        egressEnvironment(job.proxyUrl),
      );
      job.release();
      server.close();
      assert.deepEqual(hits, []);
    } finally {
      await proxy.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not open a raw tcp:// HLS segment beside the proxy', async () => {
    const trap: net.Socket[] = [];
    const silent = net.createServer((socket) => {
      trap.push(socket);
      socket.resume();
    });
    silent.listen(0, '127.0.0.1');
    await once(silent, 'listening');
    const trapPort = (silent.address() as net.AddressInfo).port;
    const proxy = new MediaEgressProxy({
      permitAddress: (address) => address === '127.0.0.1',
      permitPort: (port) => port !== trapPort,
      resolve: async () => ['127.0.0.1'],
      log: () => {},
    });
    const origin = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.2,\ntcp://127.0.0.1:${trapPort}/seg.ts\n#EXT-X-ENDLIST\n`);
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const originPort = (origin.address() as net.AddressInfo).port;
    try {
      const job = await proxy.issue(60_000, { ports: RADIO_EGRESS_PORTS });
      const result = await runFfmpeg(
        [
          '-protocol_whitelist', 'http,https,tls,tcp,httpproxy,crypto',
          '-format_whitelist', 'hls,mpegts,mp3',
          '-allowed_extensions', 'ALL',
          '-i', `http://127.0.0.1:${originPort}/live.m3u8`,
          '-t', '0.15',
          '-f', 'null',
          '-',
        ],
        egressEnvironment(job.proxyUrl),
      );
      job.release();
      assert.notEqual(result.status, 0);
      assert.equal(trap.length, 0, 'tcp:// must not connect around the proxy');
    } finally {
      for (const socket of trap) socket.destroy();
      origin.close();
      silent.close();
      await proxy.close();
    }
  });

  it('fetches HTTP Icecast-style bytes through the checked proxy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ts6-radio-http-'));
    const proxy = new MediaEgressProxy({
      permitAddress: (address) => address === '127.0.0.1',
      permitPort: () => true,
      resolve: async () => ['127.0.0.1'],
      log: () => {},
    });
    try {
      const mp3 = join(dir, 'tone.mp3');
      const made = spawnSync('ffmpeg', ['-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-q:a', '9', '-y', mp3], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
      const body = await readFile(mp3);
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(body);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as import('node:net').AddressInfo).port;
      const job = await proxy.issue(60_000, { ports: RADIO_EGRESS_PORTS });
      const result = await runFfmpeg(buildPcmStreamArgs(`http://127.0.0.1:${port}/stream`), egressEnvironment(job.proxyUrl));
      job.release();
      server.close();
      assert.equal(result.status, 0, result.stderr);
    } finally {
      await proxy.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
