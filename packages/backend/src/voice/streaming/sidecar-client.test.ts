import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { SidecarClient } from './sidecar-client.js';

describe('sidecar client', () => {
  let server: Server;
  let client: SidecarClient;
  const requests: Array<{ url?: string; body: any; auth?: string }> = [];
  let probeStatus = 200;
  let probeBody = '{"streams":[{"width":1280,"height":720}],"format":{}}';

  const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });

  before(async () => {
    server = createServer(async (req, res) => {
      const raw = await readBody(req);
      requests.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization });
      if (req.url === '/probe') {
        res.statusCode = probeStatus;
        res.end(probeStatus === 200 ? probeBody : 'probe failed');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', encoder: { requested: 'vp8', active: 'vp8' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    client = new SidecarClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 's3cret');
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('sends the source allowlist with POST /source', async () => {
    requests.length = 0;
    await client.setSource('http://192.168.1.20/live.m3u8', { mode: 'live', allowedHosts: ['192.168.1.20'] });
    assert.equal(requests[0].url, '/source');
    assert.deepEqual(requests[0].body.allowedHosts, ['192.168.1.20']);
    assert.equal(requests[0].auth, 'Bearer s3cret');
  });

  it('returns ffprobe JSON from POST /probe as text', async () => {
    requests.length = 0;
    probeStatus = 200;
    const out = await client.probe('https://cdn.example/a.m3u8', ['threadfin.lan'], 5_000);
    assert.equal(out, probeBody);
    assert.deepEqual(requests[0].body, { source: 'https://cdn.example/a.m3u8', allowedHosts: ['threadfin.lan'] });
  });

  it('rejects when the sidecar refuses the probe', async () => {
    probeStatus = 422;
    await assert.rejects(client.probe('https://cdn.example/a.m3u8', [], 5_000), /Sidecar \/probe: 422/);
  });
});
