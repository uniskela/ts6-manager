/** Local fixture origin. Not copied into the production image. */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Resolve tool binaries without depending on a mutable PATH. */
function resolveBin(name, candidates) {
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* try next */
    }
  }
  throw new Error(`${name} not found in fixed paths: ${candidates.join(', ')}`);
}

const OPENSSL = resolveBin('openssl', ['/usr/bin/openssl', '/bin/openssl']);
const FFMPEG = resolveBin('ffmpeg', ['/usr/bin/ffmpeg', '/bin/ffmpeg']);

function openssl(args) {
  const result = spawnSync(OPENSSL, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'openssl failed');
}

const dir = await mkdtemp(join(tmpdir(), 'world-'));
const crossTargetPath = join(dir, 'cross-target');
openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'),
  '-days', '1', '-nodes', '-subj', '/CN=TS6-FETCH-CA']);
await writeFile(join(dir, 'san.cnf'), 'subjectAltName=DNS:origin\n');
openssl(['req', '-newkey', 'rsa:2048', '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.csr'),
  '-nodes', '-subj', '/CN=origin']);
openssl(['x509', '-req', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'),
  '-out', join(dir, 'server.crt'), '-days', '1', '-CAcreateserial', '-extfile', join(dir, 'san.cnf')]);
const ts = join(dir, 'seg.ts');
const made = spawnSync(FFMPEG, ['-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
  '-c:a', 'aac', '-f', 'mpegts', '-y', ts], { encoding: 'utf8' });
if (made.status !== 0) throw new Error(made.stderr);
const mp3 = join(dir, 'tone.mp3');
const mp3made = spawnSync(FFMPEG, ['-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-q:a', '9', '-y', mp3], { encoding: 'utf8' });
if (mp3made.status !== 0) throw new Error(mp3made.stderr);
const key = Buffer.alloc(16, 0x11);
openssl(['enc', '-aes-128-cbc', '-in', ts, '-out', join(dir, 'seg.enc'),
  '-K', key.toString('hex'), '-iv', '0'.repeat(32)]);
const encrypted = await readFile(join(dir, 'seg.enc'));
const tone = await readFile(mp3);
// CA stays under private mkdtemp dir (dir/ca.crt); lab scripts discover /tmp/world-*.

const trapPeers = [];
const trap = net.createServer((socket) => {
  trapPeers.push(`${socket.remoteAddress}:${socket.remotePort}`);
  socket.end();
});
trap.listen(9400, '0.0.0.0');
await once(trap, 'listening');

const origin = https.createServer({
  cert: await readFile(join(dir, 'server.crt')),
  key: await readFile(join(dir, 'server.key')),
}, async (req, res) => {
  if (req.url?.startsWith('/live.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000\n#EXTINF:0.4,\nseg.ts\n#EXT-X-ENDLIST\n');
    return;
  }
  if (req.url?.startsWith('/cross.m3u8')) {
    let target = '127.0.0.1:9';
    try { target = (await readFile(crossTargetPath, 'utf8')).trim() || target; } catch { /* none */ }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttpproxy://${target}/http://origin:8000/stream\n#EXT-X-ENDLIST\n`);
    return;
  }
  if (req.url?.startsWith('/bypass.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.4,\nhttpproxy://world:9400/seg.ts\n#EXT-X-ENDLIST\n');
    return;
  }
  if (req.url?.startsWith('/key.bin')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(key);
    return;
  }
  if (req.url?.startsWith('/seg.ts')) {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(encrypted);
    return;
  }
  if (req.url?.startsWith('/hold')) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const iv = setInterval(() => { try { res.write(tone); } catch { /* closed */ } }, 400);
    req.on('close', () => clearInterval(iv));
    return;
  }
  if (req.url?.startsWith('/https-bad.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://origin:8080/stream\n#EXT-X-ENDLIST\n');
    return;
  }
  if (req.url?.startsWith('/file-token.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///jobs/.token\n#EXT-X-ENDLIST\n');
    return;
  }
  if (req.url?.startsWith('/unix-ctl.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nunix:///ctl/proxy.sock\n#EXT-X-ENDLIST\n');
    return;
  }
  if (req.url?.startsWith('/stream')) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(tone);
    return;
  }
  res.writeHead(404).end();
});
origin.listen(8443, '0.0.0.0');
await once(origin, 'listening');

openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'bad.key'), '-out', join(dir, 'bad.crt'),
  '-days', '1', '-nodes', '-subj', '/CN=origin', '-addext', 'subjectAltName=DNS:origin']);
const untrusted = https.createServer({
  cert: await readFile(join(dir, 'bad.crt')),
  key: await readFile(join(dir, 'bad.key')),
}, (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(tone);
});
untrusted.listen(8080, '0.0.0.0');
await once(untrusted, 'listening');

const iceast = http.createServer((req, res) => {
  if (req.url?.startsWith('/https-hop.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nhttps://origin:8443/live.m3u8\n');
    return;
  }
  if (req.url?.startsWith('/https-bad.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://origin:8080/stream\n#EXT-X-ENDLIST\n');
    return;
  }
  if (req.url?.startsWith('/hold')) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const iv = setInterval(() => { try { res.write(tone); } catch { /* closed */ } }, 400);
    req.on('close', () => clearInterval(iv));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(tone);
});
iceast.listen(8000, '0.0.0.0');
await once(iceast, 'listening');

http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ trapPeers }));
}).listen(9500, '0.0.0.0');

process.stdout.write('WORLD ready\n');
