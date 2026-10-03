import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { channelBannerRoutes, channelBannerPublicRoutes } from './channel-banners.routes.js';
import { settingsRoutes } from './settings.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { parsePublicUrl } from '../utils/app-settings.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

async function fixture(role = 'admin') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'banner-route-'));
  const savedEnv = { data: process.env.DATA_DIR, url: process.env.PUBLIC_URL };
  process.env.DATA_DIR = dir; delete process.env.PUBLIC_URL;
  const rows: any[] = []; const settings = new Map<string, string>();
  const prisma: any = {
    appSetting: {
      findUnique: async ({ where }: any) => settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
      upsert: async ({ where, update }: any) => { settings.set(where.key, update.value); return {}; },
      deleteMany: async ({ where }: any) => { settings.delete(where.key); return { count: 1 }; },
    },
    adminAuditEvent: {
      create: async ({ data }: any) => { rows.push(data); return { id: 'event' }; },
      updateMany: async ({ where, data }: any) => { for (const row of rows) if (row.operationId === where.operationId) Object.assign(row, data); return { count: 1 }; },
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  const app = express(); app.use(express.json());
  app.use('/api/banners', channelBannerPublicRoutes);
  app.use((req, _res, next) => { (req as any).user = { id: 1, username: 'admin', role }; next(); });
  app.locals.prisma = prisma;
  app.use('/api/channel-banners', channelBannerRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use(errorHandler);
  const server = app.listen(0); await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    dir, base, rows, settings,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (savedEnv.data === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedEnv.data;
      if (savedEnv.url === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = savedEnv.url;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function form(data: Buffer = png, filename = '../../outside.png') { const body = new FormData(); body.append('file', new Blob([data]), filename); return body; }
const putPublicUrl = (base: string, publicUrl: string) => fetch(`${base}/api/settings/public-url`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicUrl }) });

test('upload stores a random server-generated name, audits, and serves it publicly without auth', async () => {
  const f = await fixture();
  try {
    const res = await fetch(`${f.base}/api/channel-banners`, { method: 'POST', body: form() });
    assert.equal(res.status, 201);
    const banner = await res.json();
    assert.match(banner.name, /^[0-9a-f]{32}\.png$/);
    assert.equal(banner.path, `/api/banners/${banner.name}`);
    assert.equal(banner.url, null, 'no public URL configured yet');
    assert.deepEqual(await readdir(path.join(f.dir, 'channel-banners')), [banner.name]);
    assert.equal(f.rows[0].action, 'channel_banner.upload'); assert.equal(f.rows[0].targetId, banner.name); assert.equal(f.rows[0].outcome, 'success');

    const image = await fetch(`${f.base}${banner.path}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(image.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    const etag = image.headers.get('etag');
    assert.ok(etag);
    // node:http, not fetch: fetch marks requests with a manual If-None-Match as uncacheable.
    const revalidated = await new Promise<number | undefined>((resolve, reject) => {
      http.get(`${f.base}${banner.path}`, { headers: { 'If-None-Match': etag } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(revalidated, 304);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  } finally { await f.close(); }
});

test('links use the saved public URL, falling back to PUBLIC_URL', async () => {
  const f = await fixture();
  try {
    await fetch(`${f.base}/api/channel-banners`, { method: 'POST', body: form(webp, 'b.webp') });
    process.env.PUBLIC_URL = 'https://env.example.com';
    let list = await (await fetch(`${f.base}/api/channel-banners`)).json();
    assert.equal(list.publicUrlSource, 'env');
    assert.match(list.banners[0].url, /^https:\/\/env\.example\.com\/api\/banners\/[0-9a-f]{32}\.webp$/);

    assert.equal((await putPublicUrl(f.base, 'https://ts.example.com/manager/')).status, 200);
    list = await (await fetch(`${f.base}/api/channel-banners`)).json();
    assert.equal(list.publicUrlSource, 'setting');
    assert.equal(list.banners[0].url, `https://ts.example.com/manager/api/banners/${list.banners[0].name}`);
    assert.equal(f.rows.at(-1).action, 'settings.public_url_update');

    assert.equal((await putPublicUrl(f.base, '')).status, 200);
    assert.equal(f.settings.size, 0, 'empty clears the saved setting');
  } finally { await f.close(); }
});

test('public URL validation', () => {
  assert.deepEqual(parsePublicUrl('https://ts.example.com/'), { ok: true, value: 'https://ts.example.com' });
  assert.deepEqual(parsePublicUrl(' http://10.0.0.5:3000 '), { ok: true, value: 'http://10.0.0.5:3000' });
  assert.deepEqual(parsePublicUrl(''), { ok: true, value: null });
  for (const bad of ['ts.example.com', 'ftp://x', 'javascript:alert(1)', 'https://u:p@x', 'https://x/?a=1', 'https://x/#y', 42]) {
    assert.equal(parsePublicUrl(bad).ok, false, String(bad));
  }
});

test('non-images, oversized files and multiple files are rejected before saving', async () => {
  const f = await fixture();
  try {
    const two = form(); two.append('file', new Blob([png]), 'second.png');
    for (const body of [form(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.png'), form(Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)])), two]) {
      assert.equal((await fetch(`${f.base}/api/channel-banners`, { method: 'POST', body })).status, 400);
    }
    assert.deepEqual(await readdir(f.dir), []);
    assert.equal(f.rows.length, 0);
  } finally { await f.close(); }
});

test('delete removes the file, and the public link and unknown names 404', async () => {
  const f = await fixture();
  try {
    const banner = await (await fetch(`${f.base}/api/channel-banners`, { method: 'POST', body: form() })).json();
    assert.equal((await fetch(`${f.base}/api/channel-banners/${banner.name}`, { method: 'DELETE' })).status, 200);
    assert.equal(f.rows.at(-1).action, 'channel_banner.delete');
    assert.deepEqual(await readdir(path.join(f.dir, 'channel-banners')), []);
    assert.equal((await fetch(`${f.base}${banner.path}`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/channel-banners/${banner.name}`, { method: 'DELETE' })).status, 404);
  } finally { await f.close(); }
});

test('public route never serves files it did not generate', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.dir, 'channel-banners'), { recursive: true });
    await writeFile(path.join(f.dir, 'channel-banners', 'notes.png'), png);
    await writeFile(path.join(f.dir, 'secret.png'), png);
    for (const name of ['notes.png', '..%2Fsecret.png', `${'a'.repeat(32)}.svg`]) {
      assert.equal((await fetch(`${f.base}/api/banners/${name}`)).status, 404, name);
    }
    const list = await (await fetch(`${f.base}/api/channel-banners`)).json();
    assert.deepEqual(list.banners, []);
  } finally { await f.close(); }
});

test('banner management and the public URL setting are admin only', async () => {
  const f = await fixture('viewer');
  try {
    assert.equal((await fetch(`${f.base}/api/channel-banners`)).status, 403);
    assert.equal((await fetch(`${f.base}/api/channel-banners`, { method: 'POST', body: form() })).status, 403);
    assert.equal((await putPublicUrl(f.base, 'https://x.example.com')).status, 403);
    assert.equal(f.rows.length, 0);
    assert.deepEqual(await readdir(f.dir), []);
  } finally { await f.close(); }
});
