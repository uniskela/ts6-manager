import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import net from 'node:net';
import { iconRoutes, MAX_ICON_BYTES, parseIconId } from './icons.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { crc32 } from '../utils/ts-file-transfer.js';

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from('icon-bytes')]);
const pngId = crc32(png);

let nextConfigId = 1000;

/** Minimal TeamSpeak stand-in: ft* query commands plus the file-transfer port. */
async function fixture(role = 'admin', refuse?: { status: string; msg: string }, isDemo = false) {
  const files = new Map<string, Buffer>();
  const commands: string[] = [];
  const transfers = new Map<string, { kind: 'up' | 'down'; name: string; size: number }>();
  const ft = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let transfer: { kind: 'up' | 'down'; name: string; size: number } | undefined;
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!transfer && buffered.length >= 32) {
        transfer = transfers.get(buffered.subarray(0, 32).toString());
        buffered = buffered.subarray(32);
        if (!transfer) return socket.destroy();
        if (transfer.kind === 'down') return socket.end(files.get(transfer.name));
      }
      if (transfer?.kind === 'up' && buffered.length >= transfer.size) { files.set(transfer.name, buffered.subarray(0, transfer.size)); socket.end(); }
    });
  });
  await new Promise<void>((resolve) => ft.listen(0, '127.0.0.1', resolve));
  const ftPort = (ft.address() as net.AddressInfo).port;

  const params = (command: string) => Object.fromEntries(command.split(' ').slice(1).map((part) => { const i = part.indexOf('='); return [part.slice(0, i), part.slice(i + 1).replace(/\\\//g, '/')]; }));
  const bridge = {
    executeCommand: async (_configId: number, _sid: number, command: string) => {
      commands.push(command);
      const p = params(command);
      const stored = (p.name ?? '').replace(/^\//, '');
      if (command.startsWith('ftgetfilelist')) {
        if (files.size === 0) throw new Error('TS error 1281: database empty result set');
        return [...files, ['notes.txt', Buffer.from('x')] as const].map(([name, data]) => `cid=0 path=\\/icons name=${name} size=${data.length} datetime=1700000000 type=1`).join('|');
      }
      if (command.startsWith('ftinitupload')) {
        if (refuse) return `status=${refuse.status} msg=${refuse.msg}`;
        const key = String(transfers.size).padStart(32, 'u');
        transfers.set(key, { kind: 'up', name: stored, size: Number(p.size) });
        return `clientftfid=${p.clientftfid} serverftfid=1 ftkey=${key} port=${ftPort} seekpos=0`;
      }
      if (command.startsWith('ftinitdownload')) {
        const data = files.get(stored);
        if (!data) throw new Error('TS error 2051: file not found');
        const key = String(transfers.size).padStart(32, 'd');
        transfers.set(key, { kind: 'down', name: stored, size: data.length });
        return `clientftfid=${p.clientftfid} serverftfid=1 ftkey=${key} port=${ftPort} size=${data.length}`;
      }
      if (command.startsWith('ftdeletefile')) { files.delete(stored); return ''; }
      return '';
    },
    getSshReconnectPauseSeconds: () => 0,
  };
  const rows: any[] = [];
  const prisma: any = {
    tsServerConfig: { findUnique: async () => ({ isDemo, host: '127.0.0.1' }) },
    adminAuditEvent: {
      create: async ({ data }: any) => { rows.push(data); return { id: 'event' }; },
      updateMany: async ({ where, data }: any) => { for (const row of rows) if (row.operationId === where.operationId) Object.assign(row, data); return { count: 1 }; },
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: 1, username: 'admin', role }; next(); });
  app.locals.prisma = prisma;
  app.locals.botEngine = { getEventBridge: () => bridge };
  // A fresh connection id per fixture keeps the module-level preview cache from leaking between tests.
  const configId = nextConfigId++;
  app.use('/api/servers/:configId/vs/:sid/icons', iconRoutes);
  app.use(errorHandler);
  const server = app.listen(0); await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/servers/${configId}/vs/1/icons`;
  return {
    base, files, commands, rows,
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await new Promise<void>((resolve) => ft.close(() => resolve())); },
  };
}
function form(data: Buffer = png) { const body = new FormData(); body.append('file', new Blob([data]), '../../evil.png'); return body; }

test('icon ids are unsigned CRC32 values', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(parseIconId('3421780262'), 3421780262);
  assert.equal(parseIconId('-873187034'), 3421780262, 'signed ids map to the same icon');
  for (const bad of ['0', '', 'abc', '12.5', '99999999999', '../1', undefined]) assert.equal(parseIconId(bad), null, String(bad));
});

test('upload stores the image as icon_<crc32>, audits it, and lists and previews it', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await (await fetch(f.base)).json()).icons, [], 'an empty icon folder lists as no icons');
    const res = await fetch(f.base, { method: 'POST', body: form() });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).id, pngId);
    assert.deepEqual(f.files.get(`icon_${pngId}`), png);
    assert.ok(f.commands.some((c) => c.startsWith('ftinitupload') && c.includes(`name=\\/icon_${pngId}`) && c.includes('cid=0')));
    assert.equal(f.rows[0].action, 'server_icon.upload'); assert.equal(f.rows[0].targetId, String(pngId)); assert.equal(f.rows[0].outcome, 'success');
    assert.ok(!JSON.stringify(f.rows).includes('evil'), 'the original filename is never recorded');

    const list = await (await fetch(f.base)).json();
    assert.deepEqual(list.icons.map((i: any) => [i.id, i.size]), [[pngId, png.length]], 'non-icon files are left out');
    assert.equal(list.maxBytes, MAX_ICON_BYTES);

    const image = await fetch(`${f.base}/${pngId}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  } finally { await f.close(); }
});

test('previews download from TeamSpeak once and are then cached', async () => {
  const f = await fixture();
  try {
    f.files.set(`icon_${pngId}`, png);
    for (let i = 0; i < 2; i++) assert.deepEqual(Buffer.from(await (await fetch(`${f.base}/${pngId}`)).arrayBuffer()), png);
    assert.equal(f.commands.filter((c) => c.startsWith('ftinitdownload')).length, 1);
    assert.equal((await fetch(`${f.base}/12345`)).status, 404);
    assert.equal((await fetch(`${f.base}/not-a-number`)).status, 404);
    f.files.set('icon_777', Buffer.from('<svg onload=alert(1)>'));
    assert.equal((await fetch(`${f.base}/777`)).status, 415, 'non-image bytes are never served');
  } finally { await f.close(); }
});

test('delete removes the icon and audits it', async () => {
  const f = await fixture();
  try {
    f.files.set(`icon_${pngId}`, png);
    assert.equal((await fetch(`${f.base}/${pngId}`, { method: 'DELETE' })).status, 200);
    assert.equal(f.files.size, 0);
    assert.equal(f.rows.at(-1).action, 'server_icon.delete'); assert.equal(f.rows.at(-1).targetId, String(pngId));
    assert.equal((await fetch(`${f.base}/${pngId}`)).status, 404, 'the cached preview is dropped');
  } finally { await f.close(); }
});

test('non-images, oversized files and refused transfers are rejected', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.base, { method: 'POST', body: form(Buffer.from('<svg></svg>')) })).status, 400);
    assert.equal((await fetch(f.base, { method: 'POST', body: form(Buffer.concat([png, Buffer.alloc(MAX_ICON_BYTES)])) })).status, 400);
    assert.equal(f.files.size, 0);
    assert.ok(!f.commands.some((c) => c.startsWith('ftinitupload')));
  } finally { await f.close(); }
  const refused = await fixture('admin', { status: '2568', msg: 'insufficient\\sclient\\spermissions' });
  try {
    const res = await fetch(refused.base, { method: 'POST', body: form() });
    assert.equal(res.status, 403);
    assert.equal(refused.rows[0].outcome, 'failure');
  } finally { await refused.close(); }
});

test('uploading and deleting icons are admin only; viewers can still list', async () => {
  const f = await fixture('viewer');
  try {
    assert.equal((await fetch(f.base, { method: 'POST', body: form() })).status, 403);
    assert.equal((await fetch(`${f.base}/${pngId}`, { method: 'DELETE' })).status, 403);
    assert.equal((await fetch(f.base)).status, 200);
    assert.equal(f.rows.length, 0);
  } finally { await f.close(); }
});

test('the demo connection lists icons but refuses transfers with a clear message', async () => {
  const f = await fixture('admin', undefined, true);
  try {
    assert.equal((await fetch(f.base)).status, 200);
    const res = await fetch(f.base, { method: 'POST', body: form() });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /demo connection/);
    assert.equal((await fetch(`${f.base}/${pngId}`)).status, 400);
  } finally { await f.close(); }
});

test('an upload that overwrites an icon id replaces its cached preview', async () => {
  const f = await fixture();
  try {
    const older = Buffer.concat([png.subarray(0, 16), Buffer.from('older-bytes')]);
    f.files.set(`icon_${pngId}`, older);
    assert.deepEqual(Buffer.from(await (await fetch(`${f.base}/${pngId}`)).arrayBuffer()), older);
    assert.equal((await fetch(f.base, { method: 'POST', body: form() })).status, 201);
    assert.deepEqual(Buffer.from(await (await fetch(`${f.base}/${pngId}`)).arrayBuffer()), png);
  } finally { await f.close(); }
});
