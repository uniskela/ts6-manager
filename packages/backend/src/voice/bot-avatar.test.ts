import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCommand } from './tslib/commands.js';
import { applyBotAvatar, storedAvatarName, AVATAR_UPLOAD_REFUSED } from './bot-avatar.js';
import { saveBotAvatar, avatarImageType, readBotAvatar } from '../utils/bot-avatar-storage.js';
import { VoiceBot } from './voice-bot.js';
import { VoiceBotManager } from './voice-bot-manager.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const temps: string[] = [];
afterEach(async () => { for (const temp of temps.splice(0)) await rm(temp, { recursive: true, force: true }); });
async function tempDir() { const dir = await mkdtemp(path.join(os.tmpdir(), 'avatars-')); temps.push(dir); return dir; }

test('content sniffing rejects renamed non-images and over-200-KB images', () => {
  assert.throws(() => avatarImageType(Buffer.from('fake image')), /PNG, JPEG or GIF/);
  assert.throws(() => avatarImageType(Buffer.concat([png, Buffer.alloc(200 * 1024)])), /200 KB/);
  assert.equal(avatarImageType(png).extension, 'png');
  assert.equal(avatarImageType(Buffer.from([255, 216, 255, 224])).extension, 'jpg');
  assert.equal(avatarImageType(Buffer.from('GIF89a')).extension, 'gif');
});

test('stores only server-generated paths under bot-avatars and refuses path traversal on reads', async () => {
  const dir = await tempDir();
  const saved = await saveBotAvatar(7, png, dir);
  assert.match(saved.avatarFile, /^bot-avatars\/7\.[0-9a-f]{32}\.png$/);
  assert.deepEqual(await readFile(path.join(dir, saved.avatarFile)), png);
  await assert.rejects(readBotAvatar({ id: 7, avatarMode: 'custom', avatarFile: '../secret.png' }, dir), /Invalid avatar file/);
  await assert.rejects(saveBotAvatar(Number.NaN, png, dir), /Invalid bot ID/);
});

async function serverFixture(refuse = false, storedSize = png.length, refuseDelete = false) {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => { socket.on('data', (data) => received.push(data)); socket.on('end', () => socket.end()); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const client = Object.assign(new EventEmitter(), { getClientId: () => 42, sendCommand: (_cmd: string) => {} });
  const sent: ReturnType<typeof parseCommand>[] = [];
  client.sendCommand = (raw) => {
    const command = parseCommand(raw); sent.push(command);
    const params = { return_code: command.params.return_code, id: '0' };
    queueMicrotask(() => {
      if (command.name === 'ftinitupload') client.emit('command', refuse ? { name: 'error', params: { ...params, id: '2568' } } : { name: 'notifystartupload', params: { ftkey: 'key', port: String(port), clientftfid: command.params.clientftfid } });
      else if (command.name === 'clientgetuidfromclid') client.emit('command', { name: 'notifyclientuidfromclid', params: { clid: '42', cluid: 'AQI=' } });
      else if (command.name === 'ftgetfileinfo') client.emit('command', { name: 'notifyfileinfo', params: { name: storedAvatarName('AQI='), size: String(storedSize) } });
      else client.emit('command', { name: 'error', params: command.name === 'ftdeletefile' && refuseDelete ? { ...params, id: '2568' } : params });
    });
  };
  return { client, sent, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('uploads via file transfer, confirms stored size, then sets flag, and None clears before delete', async () => {
  const f = await serverFixture();
  try {
    await applyBotAvatar(f.client as any, '127.0.0.1', png);
    assert.deepEqual(f.sent.map((c) => c.name), ['ftinitupload', 'clientgetuidfromclid', 'ftgetfileinfo', 'clientupdate']);
    assert.equal(f.sent[0].params.name, '/avatar');
    assert.equal(f.sent[0].params.overwrite, '1');
    assert.equal(f.sent[2].params.name, '/avatar_abac');
    assert.deepEqual(Buffer.concat(f.received), Buffer.concat([Buffer.from('key'), png]));
    assert.match(f.sent[3].params.client_flag_avatar, /^[0-9a-f]{32}$/);
    await applyBotAvatar(f.client as any, '127.0.0.1', null);
    assert.deepEqual(f.sent.slice(4).map((c) => c.name), ['clientupdate', 'clientgetuidfromclid', 'ftdeletefile']);
    assert.equal(f.sent[4].params.client_flag_avatar, '');
    assert.equal(f.client.listenerCount('command'), 0);
  } finally { await f.close(); }
});

test('never flags an upload whose stored size does not match', async () => {
  const f = await serverFixture(false, 1);
  try { await assert.rejects(applyBotAvatar(f.client as any, '127.0.0.1', png), /Upload did not complete/); assert.ok(!f.sent.some((c) => c.name === 'clientupdate')); }
  finally { await f.close(); }
});

test('every connect re-uploads custom avatar; an offline change replaces the old remote file', async () => {
  const dir = await tempDir(); const saved = await saveBotAvatar(7, png, dir);
  const f = await serverFixture();
  const bot = new VoiceBot({ id: 7, serverConfigId: 1, name: 'Bot', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50, avatarMode: 'custom', avatarFile: saved.avatarFile, avatarDataDir: dir });
  const b = bot as any; b.client = f.client; b.client.connect = async () => {};
  try {
    await bot.start(); await bot.avatarSettled(); b._status = 'stopped'; await bot.start(); await bot.avatarSettled();
    assert.equal(f.sent.filter((c) => c.name === 'ftinitupload').length, 2);
    b._status = 'stopped'; const changedImage = Buffer.from(png); changedImage[changedImage.length - 1] ^= 1;
    const changed = await saveBotAvatar(7, changedImage, dir); await bot.applyAvatar({ avatarMode: 'custom', avatarFile: changed.avatarFile, avatarMd5: changed.avatarMd5 });
    assert.equal(f.sent.filter((c) => c.name === 'ftinitupload').length, 2, 'offline changes wait for connect');
    await bot.start(); await bot.avatarSettled(); assert.equal(f.sent.filter((c) => c.name === 'ftinitupload').length, 3);
    assert.equal(bot.currentConfig.avatarMode, 'custom');
    const flags = f.sent.filter((c) => c.name === 'clientupdate').map((c) => c.params.client_flag_avatar);
    assert.equal(flags[0], saved.avatarMd5); assert.equal(flags[1], saved.avatarMd5); assert.equal(flags[2], changed.avatarMd5); assert.notEqual(flags[2], flags[0]);
    assert.deepEqual(f.sent.map((c) => c.name), Array(3).fill(['ftinitupload', 'clientgetuidfromclid', 'ftgetfileinfo', 'clientupdate']).flat());
    assert.deepEqual(Buffer.concat(f.received).subarray(-(3 + changedImage.length)), Buffer.concat([Buffer.from('key'), changedImage]));
  } finally { await f.close(); }
});

test('2568 upload refusal keeps the bot connected and records the exact message', async () => {
  const dir = await tempDir(); const saved = await saveBotAvatar(7, png, dir); const f = await serverFixture(true);
  const bot = new VoiceBot({ id: 7, serverConfigId: 1, name: 'Bot', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50, avatarMode: 'custom', avatarFile: saved.avatarFile, avatarDataDir: dir });
  const b = bot as any;
  // Keep VoiceBot's permanent command/error listeners attached, as on a real connection.
  b.client.connect = async () => {};
  b.client.getClientId = f.client.getClientId;
  b.client.sendCommand = f.client.sendCommand;
  f.client.on('command', (command) => {
    b.client.emit('command', command);
    if (command.name === 'error') b.client.emit('ts3error', command.params);
  });
  try { await bot.start(); await bot.avatarSettled(); assert.equal(bot.status, 'connected'); assert.equal(bot.avatarError, AVATAR_UPLOAD_REFUSED); assert.equal(bot.lastError, 'TeamSpeak refused the avatar upload. Allow file uploads for the bot\'s server group, or choose None.'); }
  finally { await f.close(); }
});

test('None keeps an empty flag when TS6 refuses deletion of the old remote file', async () => {
  const f = await serverFixture(false, png.length, true);
  try { await applyBotAvatar(f.client as any, '127.0.0.1', null); assert.deepEqual(f.sent.map((c) => c.name), ['clientupdate', 'clientgetuidfromclid', 'ftdeletefile']); assert.equal(f.sent[0].params.client_flag_avatar, ''); assert.equal(f.client.listenerCount('command'), 0); }
  finally { await f.close(); }
});

test('manager reloads persisted custom metadata and uploads that image on the next connect', async () => {
  const dir = await tempDir(); const saved = await saveBotAvatar(7, png, dir); const f = await serverFixture();
  const prisma = { appSetting: { findUnique: async () => null }, musicBot: { findMany: async () => [{ id: 7, serverConfigId: 3, name: 'Bot', nickname: 'Bot', volume: 50, voicePort: 9987, serverConfig: { host: '127.0.0.1' }, avatarMode: 'custom', ...saved, autoStart: false }] } };
  const manager = new VoiceBotManager(prisma as any, { clients: new Set() } as any);
  try {
    await manager.start(); const bot = manager.getBot(7)!;
    assert.equal(bot.currentConfig.avatarMode, 'custom'); assert.equal(bot.currentConfig.avatarFile, saved.avatarFile); assert.equal(bot.currentConfig.avatarMd5, saved.avatarMd5);
    (bot as any).client = f.client; (f.client as any).connect = async () => {};
    bot.updateConfig({ avatarDataDir: dir }); await bot.start(); await bot.avatarSettled();
    assert.deepEqual(f.sent.map((c) => c.name), ['ftinitupload', 'clientgetuidfromclid', 'ftgetfileinfo', 'clientupdate']);
    assert.equal(f.sent.at(-1)?.params.client_flag_avatar, saved.avatarMd5);
  } finally { await f.close(); }
});

test('an offline avatar choice change clears the old refusal message immediately', async () => {
  const dir = await tempDir();
  const saved = await saveBotAvatar(7, png, dir);
  const f = await serverFixture(true);
  const bot = new VoiceBot({ id: 7, serverConfigId: 1, name: 'Bot', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50, avatarMode: 'custom', avatarFile: saved.avatarFile, avatarDataDir: dir });
  const b = bot as any;
  b.client = f.client;
  b.client.connect = async () => {};
  try {
    await bot.start(); await bot.avatarSettled();
    assert.equal(bot.avatarError, AVATAR_UPLOAD_REFUSED);
    b._status = 'stopped';
    const updates: unknown[] = [];
    bot.on('avatarChange', (value) => updates.push(value));
    await bot.applyAvatar({ avatarMode: 'none', avatarMd5: null });
    assert.equal(bot.avatarError, null);
    assert.equal(bot.lastError, '');
    assert.deepEqual(updates, [{ avatarError: null }]);
    assert.equal(f.sent.length, 1, 'changing an offline choice does not send commands');
  } finally { await f.close(); }
});

test('start does not wait for avatar upload, and stop cancels the in-flight transfer', async () => {
  const dir = await tempDir(); const saved = await saveBotAvatar(7, png, dir);
  const client = Object.assign(new EventEmitter(), { getClientId: () => 42, sendCommand: (_cmd: string) => {}, connect: async () => {}, disconnect: () => {} });
  const sent: string[] = [];
  client.sendCommand = (raw) => { sent.push(parseCommand(raw).name); }; // TS6 never answers ftinitupload
  const bot = new VoiceBot({ id: 7, serverConfigId: 1, name: 'Bot', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50, avatarMode: 'custom', avatarFile: saved.avatarFile, avatarDataDir: dir });
  (bot as any).client = client;
  const changes: unknown[] = []; bot.on('avatarChange', (value) => changes.push(value));
  let connected = false; bot.on('connected', () => { connected = true; });
  await bot.start();
  assert.equal(bot.status, 'connected'); assert.ok(connected, 'connected is emitted before avatar work finishes');
  for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent, ['ftinitupload']);
  await bot.stop(); await bot.avatarSettled();
  assert.equal(bot.avatarError, null, 'a cancelled upload is not reported as a failure');
  assert.deepEqual(changes, []);
  assert.equal(client.listenerCount('command'), 0);
});
