import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runMediaAudited } from './media-audit.js';

function setup() {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    adminAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => { rows.push({ ...data }); return { id: 'e1', ...data }; },
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
    await runMediaAudited(req, bot, 'media.music.start', async () => undefined, ['0f8fad5b-d9cb-469f-a165-70867728950e']);
    assert.equal(rows[0].action, 'media.session.switch');
  });

  it('records a stop row for each replaced session under the same operation', async () => {
    const { rows, req, bot } = setup();
    const videoId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const musicId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    req.app.locals.voiceBotManager = {
      listMediaSessions: () => [
        { id: videoId, kind: 'video', state: 'active', botId: 20, botName: 'Bravo', startedAt: 1, label: 'iptv.example' },
        { id: musicId, kind: 'music', state: 'active', botId: 12, botName: 'Alpha', startedAt: 1, label: 'Song' },
        { id: 'a3bb189e-8bf9-3888-9912-ace4e6543002', kind: 'music', state: 'active', botId: 30, botName: 'Other', startedAt: 1, label: null },
      ],
      getBot: (id: number) => ({ 20: { currentConfig: { serverConfigId: 9 } }, 12: { currentConfig: { serverConfigId: 4 } } } as any)[id],
    };
    await runMediaAudited(req, bot, 'media.video.start', async () => undefined, [videoId, musicId]);

    assert.equal(rows.length, 3);
    assert.equal(rows[0].action, 'media.session.switch');
    const stops = rows.slice(1).map((r) => [r.action, r.targetId, r.connectionId]);
    assert.deepEqual(stops, [['media.video.stop', '20', 9], ['media.music.stop', '12', 4]]);
    assert.ok(rows.every((r) => r.operationId === rows[0].operationId));
    assert.ok(rows.every((r) => r.outcome === 'success'));
    assert.ok(!JSON.stringify(rows).includes('iptv.example'));
    assert.ok(!JSON.stringify(rows).includes('Song'));
  });

  it('gives replaced-session rows the switch outcome on failure', async () => {
    const { rows, req, bot } = setup();
    const videoId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    req.app.locals.voiceBotManager = {
      listMediaSessions: () => [{ id: videoId, kind: 'video', state: 'active', botId: 20, botName: 'B', startedAt: 1, label: null }],
      getBot: () => undefined,
    };
    await assert.rejects(runMediaAudited(req, bot, 'media.music.start', async () => { throw new Error('boom'); }, [videoId]), /boom/);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.outcome === 'failure'));
    assert.equal(rows[1].connectionId, null);
  });

  it('records failures with a classified code and rethrows', async () => {
    const { rows, req, bot } = setup();
    await assert.rejects(runMediaAudited(req, bot, 'media.video.stop', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(rows[0].outcome, 'failure');
    assert.equal(rows[0].resultCode, 'unknown');
  });
});
