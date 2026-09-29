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

  it('records failures with a classified code and rethrows', async () => {
    const { rows, req, bot } = setup();
    await assert.rejects(runMediaAudited(req, bot, 'media.video.stop', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(rows[0].outcome, 'failure');
    assert.equal(rows[0].resultCode, 'unknown');
  });
});
