import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, it } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-shared-music-'));
process.env.MUSIC_DIR = path.join(root, 'music');
fs.mkdirSync(process.env.MUSIC_DIR);
const { SidecarClient } = await import('./sidecar-client.js');
const { resolvePathUnderMusicDir } = await import('./video-download.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

it('sends shared music filenames while keeping backend paths for local operations', async () => {
  const bodies: Array<{ source: string }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    bodies.push(JSON.parse(body));
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new SidecarClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    for (const name of ['clip.mp4', '.stream-123.mp4']) {
      const local = path.join(process.env.MUSIC_DIR!, name);
      fs.writeFileSync(local, 'fixture');
      assert.equal(resolvePathUnderMusicDir(name), local);
      await client.setSource(local);
      assert.equal(bodies.at(-1)?.source, `music://${name}`);
      assert.ok(fs.existsSync(local));
    }
    for (const source of ['', 'http://example.com/clip.mp4', 'https://example.com/clip.mp4']) {
      await client.setSource(source);
      assert.equal(bodies.at(-1)?.source, source);
    }

    const outside = path.join(root, 'outside.mp4');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(process.env.MUSIC_DIR!, 'escape.mp4'));
    for (const invalid of [outside, '../outside.mp4', '..', 'missing.mp4', 'file:///etc/passwd', 'escape.mp4']) {
      await assert.rejects(client.setSource(invalid));
    }
    assert.equal(bodies.length, 5, 'invalid sources never reach the sidecar');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
