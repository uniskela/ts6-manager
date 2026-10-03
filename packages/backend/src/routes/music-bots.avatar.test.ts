import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { musicBotRoutes } from './music-bots.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { AVATAR_UPLOAD_REFUSED } from '../voice/bot-avatar.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
async function fixture(role = 'admin', avatarError: string | null = null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'avatar-route-'));
  const savedEnv = process.env.DATA_DIR; process.env.DATA_DIR = dir;
  const rows: any[] = []; const applications: any[] = [];
  let dbBot: any = { id: 7, serverConfigId: 3, avatarMode: 'none', avatarFile: null, avatarMd5: null };
  const prisma: any = { musicBot: { findUnique: async ({ where }: any) => where.id === 7 ? dbBot : null, update: async ({ data }: any) => { dbBot = { ...dbBot, ...data }; return dbBot; } }, adminAuditEvent: { create: async ({ data }: any) => { rows.push(data); return { id: 'event' }; }, updateMany: async ({ where, data }: any) => { for (const row of rows) if (row.operationId === where.operationId) Object.assign(row, data); return { count: 1 }; } }, $transaction: async (fn: any) => fn(prisma) };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: 1, username: 'admin', role }; next(); });
  app.locals.prisma = prisma; app.locals.voiceBotManager = { getBot: () => ({ applyAvatar: async (data: any) => applications.push(data), avatarError }) };
  app.use('/api/music-bots', musicBotRoutes); app.use(errorHandler);
  const server = app.listen(0); await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/music-bots/7/avatar`;
  return { dir, url, rows, applications, bot: () => dbBot, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); if (savedEnv === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedEnv; await rm(dir, { recursive: true, force: true }); } };
}
function form(data = png, filename = '../../outside.png') { const body = new FormData(); body.append('file', new Blob([data]), filename); return body; }

test('avatar upload sets custom mode, uses a server-generated path, audits and applies the chosen image', async () => {
  const f = await fixture();
  try {
    const res = await fetch(f.url, { method: 'PUT', body: form() }); assert.equal(res.status, 200);
    assert.equal(f.bot().avatarMode, 'custom'); assert.equal(f.bot().avatarFile, 'bot-avatars/7.png');
    assert.deepEqual(await readdir(f.dir), ['bot-avatars']); assert.deepEqual(await readdir(path.join(f.dir, 'bot-avatars')), ['7.png']);
    assert.equal(f.rows[0].action, 'music_bot.avatar_update'); assert.equal(f.rows[0].connectionId, 3); assert.equal(f.rows[0].targetId, '7');
    assert.equal(f.applications[0].avatarMode, 'custom');
    const image = await fetch(f.url); assert.equal(image.status, 200); assert.equal(image.headers.get('cache-control'), 'no-store'); assert.equal(image.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  } finally { await f.close(); }
});

test('renamed non-image, oversized file and multiple files are rejected before saving', async () => {
  const f = await fixture();
  try {
    for (const body of [form(Buffer.from('not an image')), form(Buffer.concat([png, Buffer.alloc(200 * 1024)])), (() => { const body = form(); body.append('file', new Blob([png]), 'second.png'); return body; })()]) {
      const res = await fetch(f.url, { method: 'PUT', body }); assert.equal(res.status, 400); assert.equal(f.bot().avatarMode, 'none');
    }
    assert.deepEqual(await readdir(f.dir), []);
  } finally { await f.close(); }
});

test('None clears the choice, GET is 404 with no-store, and custom without an image is refused', async () => {
  const f = await fixture();
  try {
    let res = await fetch(`${f.url}/mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'custom' }) }); assert.equal(res.status, 400);
    await fetch(f.url, { method: 'PUT', body: form() });
    res = await fetch(`${f.url}/mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'none' }) }); assert.equal(res.status, 200); assert.equal(f.bot().avatarMode, 'none'); assert.equal(f.applications.at(-1).avatarMode, 'none');
    const image = await fetch(f.url); assert.equal(image.status, 404); assert.equal(image.headers.get('cache-control'), 'no-store');
  } finally { await f.close(); }
});

test('avatar GET and mutations are admin only', async () => {
  const f = await fixture('viewer');
  try { assert.equal((await fetch(f.url)).status, 403); assert.equal((await fetch(f.url, { method: 'PUT', body: form() })).status, 403); assert.equal(f.rows.length, 0); }
  finally { await f.close(); }
});

test('default mode serves the shipped app artwork and keeps custom available for switching back', async () => {
  const f = await fixture();
  try {
    await fetch(f.url, { method: 'PUT', body: form() });
    const change = async (mode: string) => fetch(`${f.url}/mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
    assert.equal((await change('default')).status, 200); assert.equal(f.bot().avatarMode, 'default');
    const image = await fetch(f.url); assert.equal(image.status, 200); assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.ok((await image.arrayBuffer()).byteLength <= 200 * 1024);
    assert.equal((await change('custom')).status, 200); assert.deepEqual(Buffer.from(await (await fetch(f.url)).arrayBuffer()), png);
  } finally { await f.close(); }
});

test('missing bots and invalid mode never write image state', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.url.replace('/7/', '/999/'), { method: 'PUT', body: form() })).status, 404);
    assert.equal((await fetch(`${f.url}/mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'other' }) })).status, 400);
    assert.equal(f.rows.length, 0); assert.deepEqual(await readdir(f.dir), []);
  } finally { await f.close(); }
});

test('UI bot creation chooses default independently of caller-supplied mode', async () => {
  const app = express(); app.use(express.json()); let created: any;
  app.use((req, _res, next) => { (req as any).user = { id: 1, username: 'admin', role: 'admin' }; next(); });
  app.locals.voiceBotManager = { createBot: async (data: any) => { created = data; return { id: 7 }; } };
  app.use('/api/music-bots', musicBotRoutes); app.use(errorHandler);
  const server = app.listen(0); await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/music-bots`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bot', serverConfigId: 3, avatarMode: 'none' }) });
    assert.equal(response.status, 201); assert.equal(created.avatarMode, 'default');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('audit success means the selected image was saved, even when TeamSpeak refuses application', async () => {
  const f = await fixture('admin', AVATAR_UPLOAD_REFUSED);
  try {
    const response = await fetch(f.url, { method: 'PUT', body: form() });
    assert.equal(response.status, 200);
    assert.equal(f.bot().avatarMode, 'custom');
    assert.equal(f.rows[0].action, 'music_bot.avatar_update');
    assert.equal(f.rows[0].outcome, 'success');
    assert.equal(f.rows[0].resultCode, 'ok');
    assert.equal((await fetch(f.url)).status, 200, 'chosen image remains available after refusal');
    const detail = await fetch(f.url.replace('/avatar', ''));
    assert.equal((await detail.json()).avatarError, AVATAR_UPLOAD_REFUSED);
  } finally { await f.close(); }
});
