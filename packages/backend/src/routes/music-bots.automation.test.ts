import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import express from 'express';
import { DEFAULT_BOT_AUTOMATION_SETTINGS } from '@ts6/common';
import { musicBotRoutes } from './music-bots.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { VoiceBot } from '../voice/voice-bot.js';
import type { QueueItem } from '../voice/playlist/queue.js';

async function fixture(role = 'admin', loaded = true) {
  let bot = { id: 7, serverConfigId: 3, automationSettings: null as string | null, automationState: '{"quietUntil":999}', identityData: 'private' };
  const audit: any[] = [], calls: unknown[] = [];
  const history: string[] = [];
  const sources = {
    playlist: { id: 5, serverConfigId: null as number | null, musicBot: null as { serverConfigId: number } | null },
    radio: { id: 9, serverConfigId: 3 },
  };
  const prisma: any = {
    $transaction: async (write: (tx: unknown) => Promise<void>) => write({ musicRequest: {
      upsert: async ({ create }: any) => { history.push(create.title); },
      findMany: async () => [],
    } }),
    musicBot: {
      findUnique: async ({ where }: any) => where.id === 7 ? bot : null,
      findMany: async () => [bot],
      update: async ({ data }: any) => { calls.push('save'); bot = { ...bot, ...data }; return bot; },
    },
    playlist: { findUnique: async ({ where }: any) => where.id === sources.playlist.id ? sources.playlist : null },
    radioStation: { findUnique: async ({ where }: any) => where.id === sources.radio.id ? sources.radio : null },
    adminAuditEvent: {
      create: async ({ data }: any) => { audit.push(data); return { id: 'event' }; },
      updateMany: async ({ data }: any) => { Object.assign(audit.at(-1), data); return { count: 1 }; },
    },
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: 1, username: 'admin', role }; next(); });
  app.locals.prisma = prisma;
  app.locals.voiceBotManager = {
    listBots: () => [],
    getBot: () => loaded ? { automation: { configure: async (settings: unknown) => calls.push(settings) } } : undefined,
    off: () => {},
  };
  app.use('/api/music-bots', musicBotRoutes); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/music-bots`;
  return {
    bot: () => bot, sources, audit, calls, history, prisma, manager: app.locals.voiceBotManager,
    send: (settings: unknown, id = 7) => fetch(`${url}/${id}/automation`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }),
    post: (suffix: string, body: unknown) => fetch(`${url}/7${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    get: (suffix: string) => fetch(`${url}${suffix}`).then((r) => r.json()),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('admin saves a shared playlist, applies after persistence, and audits the update', async () => {
  const f = await fixture();
  const settings = { ...DEFAULT_BOT_AUTOMATION_SETTINGS, enabled: true, source: { kind: 'playlist', id: 5 } };
  try {
    const response = await f.send(settings);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), settings);
    assert.deepEqual(JSON.parse(f.bot().automationSettings!), settings);
    assert.deepEqual(f.calls, ['save', settings]);
    assert.equal(f.audit[0].action, 'music_bot.automation_update');
    assert.equal(f.audit[0].outcome, 'success');
    assert.equal(f.audit[0].targetId, '7');
    const detail = await f.get('/7');
    assert.deepEqual(detail.automationSettings, settings);
    assert.equal(detail.automationState, undefined); assert.equal(detail.identityData, undefined);
    const list = await f.get(''); assert.deepEqual(list[0].automationSettings, settings);
  } finally { await f.close(); }
});

test('settings save while bot is offline and old rows expose disabled defaults', async () => {
  const f = await fixture('admin', false);
  try {
    assert.deepEqual((await f.get('/7')).automationSettings, DEFAULT_BOT_AUTOMATION_SETTINGS);
    assert.equal((await f.send({ ...DEFAULT_BOT_AUTOMATION_SETTINGS, stayInChannel: true })).status, 200);
    assert.deepEqual(f.calls, ['save']);
  } finally { await f.close(); }
});

test('missing and foreign sources are rejected before saves or audits', async () => {
  const f = await fixture();
  try {
    for (const source of [{ kind: 'playlist', id: 999 }, { kind: 'radio', id: 999 }]) {
      assert.equal((await f.send({ ...DEFAULT_BOT_AUTOMATION_SETTINGS, source })).status, 400);
    }
    f.sources.playlist.serverConfigId = 8;
    assert.equal((await f.send({ ...DEFAULT_BOT_AUTOMATION_SETTINGS, source: { kind: 'playlist', id: 5 } })).status, 400);
    f.sources.playlist.serverConfigId = null; f.sources.playlist.musicBot = { serverConfigId: 8 };
    assert.equal((await f.send({ ...DEFAULT_BOT_AUTOMATION_SETTINGS, source: { kind: 'playlist', id: 5 } })).status, 400);
    f.sources.radio.serverConfigId = 8;
    assert.equal((await f.send({ ...DEFAULT_BOT_AUTOMATION_SETTINGS, source: { kind: 'radio', id: 9 } })).status, 400);
    assert.equal((await f.send(DEFAULT_BOT_AUTOMATION_SETTINGS, 999)).status, 404);
    assert.equal((await f.send(DEFAULT_BOT_AUTOMATION_SETTINGS, -1)).status, 400);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.audit, []);
  } finally { await f.close(); }
});

test('only admins can change automation; local radio sources are accepted', async () => {
  const admin = await fixture(), viewer = await fixture('viewer');
  try {
    const settings = { ...DEFAULT_BOT_AUTOMATION_SETTINGS, enabled: true, source: { kind: 'radio', id: 9 } };
    assert.equal((await admin.send(settings)).status, 200);
    assert.equal((await viewer.send(settings)).status, 403);
    assert.deepEqual(viewer.calls, []); assert.deepEqual(viewer.audit, []);
  } finally { await admin.close(); await viewer.close(); }
});

test('overlapping settings saves apply in the same order they persist', async () => {
  const f = await fixture();
  const first = { ...DEFAULT_BOT_AUTOMATION_SETTINGS, quietPeriodSeconds: 60 };
  const second = { ...DEFAULT_BOT_AUTOMATION_SETTINGS, quietPeriodSeconds: 120 };
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const update = f.prisma.musicBot.update;
  let firstSave = true;
  f.prisma.musicBot.update = async (args: any) => {
    if (firstSave) { firstSave = false; entered(); await gate; }
    return update(args);
  };
  try {
    const saveFirst = f.send(first); await started;
    const saveSecond = f.send(second);
    release();
    assert.equal((await saveFirst).status, 200); assert.equal((await saveSecond).status, 200);
    assert.deepEqual(f.calls, ['save', first, 'save', second]);
    assert.deepEqual(JSON.parse(f.bot().automationSettings!), second);
  } finally { release(); await f.close(); }
});

test('a failed settings write leaves runtime settings alone', async () => {
  const f = await fixture();
  f.prisma.musicBot.update = async () => { throw new Error('settings store unavailable'); };
  try {
    assert.equal((await f.send(DEFAULT_BOT_AUTOMATION_SETTINGS)).status, 500);
    assert.deepEqual(f.calls, []); assert.equal(f.bot().automationSettings, null);
    assert.equal(f.audit[0].outcome, 'failure');
  } finally { await f.close(); }
});

for (const playlist of [false, true]) for (const cancel of ['none', 'stop', 'newer']) {
  test(`audited ${playlist ? 'playlist' : 'song'} start respects ${cancel} during the audit wait`, async () => {
    const f = await fixture();
    const bot = new VoiceBot({ id: 7, serverConfigId: 3, name: 'DJ', nickname: 'DJ',
      serverHost: '127.0.0.1', serverPort: 9987, volume: 50 });
    const voice = bot as any;
    voice._status = 'playing';
    voice._nowPlaying = { id: 'auto', title: 'Auto-DJ' };
    voice.client.sendCommand = () => {};
    voice.client.sendVoiceStop = () => {};
    const played: string[] = [];
    let owned = true;
    voice.automation = {
      configuration: { enabled: true },
      requestQueued() { if (owned) { owned = false; bot.clearPlayback('channel_empty'); } },
      manualStop() {},
      reconcile: async () => {},
    };
    voice.play = async (item: QueueItem) => {
      played.push(item.id);
      voice._status = 'playing';
      voice._nowPlaying = item;
      return [];
    };
    f.manager.getBot = () => bot;
    const songs = [1, 2, 3].map(id => ({ id, title: `Song ${id}`, source: 'local', filePath: `/${id}.mp3` }));
    f.prisma.song = { findUnique: async ({ where }: any) => songs.find(song => song.id === where.id) };
    f.prisma.playlist.findUnique = async () => ({ songs: songs.map(song => ({ song })) });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const create = f.prisma.adminAuditEvent.create;
    let firstAudit = true;
    f.prisma.adminAuditEvent.create = async (args: unknown) => {
      if (firstAudit) { firstAudit = false; entered(); await gate; }
      return create(args);
    };
    try {
      const pending = playlist
        ? f.post('/queue/playlist', { playlistId: 5, clearFirst: true, autoplay: true })
        : f.post('/play', { songId: 1 });
      await started;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(bot.nowPlaying?.id, 'auto', 'the audit wait must not preempt playback');
      assert.equal(bot.queue.length, 0, 'the audit wait must not enqueue unaudited playback');
      assert.deepEqual(played, []);
      if (cancel !== 'none') {
        const response = cancel === 'stop'
          ? await f.post('/stop-playback', {})
          : await f.post('/play', { songId: 2 });
        assert.equal(response.status, 200);
      }
      release();
      assert.equal((await pending).status, 200);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(played, cancel === 'none' ? ['1'] : cancel === 'stop' ? [] : ['2']);
      assert.equal(bot.queue.current?.id ?? null, cancel === 'none' ? '1' : cancel === 'stop' ? null : '2');
      assert.equal(bot.queue.upcomingCount, playlist && cancel === 'none' ? 2 : 0);
      assert.deepEqual(f.history, cancel === 'stop' ? [] : cancel === 'newer' ? ['Song 2']
        : playlist ? ['Song 1', 'Song 2', 'Song 3'] : ['Song 1']);
    } finally { release(); await f.close(); }
  });
}
