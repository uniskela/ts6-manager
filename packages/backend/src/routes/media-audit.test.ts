import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { runMediaAudited } from './media-audit.js';

function setup() {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    adminAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => { rows.push({ ...data }); return { id: `e${rows.length}`, ...data }; },
      updateMany: async ({ where, data }: any) => {
        for (const r of rows) if (r.operationId === where.operationId) Object.assign(r, data);
        return { count: 1 };
      },
    },
  };
  const req = { app: { locals: { prisma } }, user: { id: 3, username: 'admin' } } as any;
  const bot = { id: 12, currentConfig: { serverConfigId: 4 } } as any;
  return { rows, req, bot };
}

function managerWith(serverByBot: Record<number, number>) {
  return Object.assign(new EventEmitter(), {
    getBot: (id: number) => (id in serverByBot ? { currentConfig: { serverConfigId: serverByBot[id] } } : undefined),
  });
}

function session(id: string, kind: 'music' | 'video', botId: number, label: string | null) {
  return { id, kind, state: 'active', botId, botName: `bot${botId}`, startedAt: 1, label };
}

describe('media audit', () => {
  it('records bot, connection and outcome without source data', async () => {
    const { rows, req, bot } = setup();
    req.body = { source: 'https://user:pw@iptv.example/live/1.m3u8?token=secret' };
    await runMediaAudited(req, bot, 'media.video.start', async () => 'ok');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'media.video.start');
    assert.equal(rows[0].targetType, 'music_bot');
    assert.equal(rows[0].targetId, '12');
    assert.equal(rows[0].connectionId, 4);
    assert.equal(rows[0].outcome, 'success');
    assert.ok(!JSON.stringify(rows).includes('iptv.example'));
    assert.ok(!JSON.stringify(rows).includes('secret'));
  });

  it('records a confirmed replacement as a session switch', async () => {
    const { rows, req, bot } = setup();
    await runMediaAudited(req, bot, 'media.music.start', async () => [], ['0f8fad5b-d9cb-469f-a165-70867728950e']);
    assert.equal(rows[0].action, 'media.session.switch');
  });

  it('records a stop row for each session the switch actually stopped', async () => {
    const { rows, req, bot } = setup();
    const videoId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const musicId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const manager = managerWith({ 20: 9, 12: 4 });
    req.app.locals.voiceBotManager = manager;

    await runMediaAudited(req, bot, 'media.video.start', async () => {
      manager.emit('mediaSessionReplaced', session(videoId, 'video', 20, 'iptv.example'));
      manager.emit('mediaSessionReplaced', session(musicId, 'music', 12, 'Song'));
      // Not confirmed by this request: never recorded against it.
      manager.emit('mediaSessionReplaced', session('9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', 'music', 30, null));
    }, [videoId, musicId]);

    assert.equal(rows.length, 3);
    assert.equal(rows[0].action, 'media.session.switch');
    const stops = rows.slice(1).map((r) => [r.action, r.targetId, r.connectionId]);
    assert.deepEqual(stops, [['media.video.stop', '20', 9], ['media.music.stop', '12', 4]]);
    assert.ok(rows.every((r) => r.operationId === rows[0].operationId));
    assert.ok(rows.every((r) => r.outcome === 'success'));
    assert.ok(!JSON.stringify(rows).includes('iptv.example'));
    assert.ok(!JSON.stringify(rows).includes('Song'));
    assert.equal(manager.listenerCount('mediaSessionReplaced'), 0);
  });

  it('does not invent stop rows for sessions gone before dispatch', async () => {
    const { rows, req, bot } = setup();
    req.app.locals.voiceBotManager = managerWith({});
    // Caller still confirmed the id, but dispatch stopped nothing (session already ended).
    await runMediaAudited(req, bot, 'media.video.start', async () => [], ['0f8fad5b-d9cb-469f-a165-70867728950e']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'media.session.switch');
    assert.equal(rows[0].outcome, 'success');
  });

  it('keeps a stop that happened before the new start failed', async () => {
    const { rows, req, bot } = setup();
    const videoId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const manager = managerWith({});
    req.app.locals.voiceBotManager = manager;
    await assert.rejects(runMediaAudited(req, bot, 'media.music.start', async () => {
      manager.emit('mediaSessionReplaced', session(videoId, 'video', 20, null));
      throw new Error('boom');
    }, [videoId]), /boom/);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, 'media.session.switch');
    assert.equal(rows[0].outcome, 'failure');
    assert.equal(rows[1].action, 'media.video.stop');
    assert.equal(rows[1].outcome, 'success');
    assert.equal(rows[1].operationId, rows[0].operationId);
    assert.equal(manager.listenerCount('mediaSessionReplaced'), 0);
  });

  it('records failures with a classified code and rethrows', async () => {
    const { rows, req, bot } = setup();
    await assert.rejects(runMediaAudited(req, bot, 'media.video.stop', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(rows[0].outcome, 'failure');
    assert.equal(rows[0].resultCode, 'unknown');
  });
});
