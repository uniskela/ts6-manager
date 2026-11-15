import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeDiscordCommandAudit } from './command-audit.js';

describe('writeDiscordCommandAudit', () => {
  it('persists allow-listed fields and never stores option values or secrets', async () => {
    const rows: unknown[] = [];
    const prisma = {
      adminAuditEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data);
          return { id: '1' };
        },
      },
    };
    await writeDiscordCommandAudit(prisma, {
      guildId: '111000000000000001',
      userId: '222000000000000002',
      command: 'play',
      result: 'ok',
    });
    await writeDiscordCommandAudit(prisma, {
      guildId: '111000000000000001',
      userId: '222000000000000002',
      command: 'ts.help',
      result: 'rate_limited',
    });
    assert.equal(rows.length, 2);
    const ok = rows[0] as Record<string, unknown>;
    assert.equal(ok.action, 'discord.command');
    assert.equal(ok.outcome, 'success');
    assert.equal(ok.resultCode, 'ok');
    assert.equal(ok.actorUserId, 0);
    assert.equal(ok.actorUsername, 'discord:222000000000000002');
    assert.equal(ok.targetType, 'discord_guild');
    assert.equal(ok.targetId, 'play@111000000000000001');
    assert.doesNotMatch(JSON.stringify(rows), /https?:|token|password|query=/i);
    const limited = rows[1] as Record<string, unknown>;
    assert.equal(limited.outcome, 'failure');
    assert.equal(limited.resultCode, 'rate_limited');
  });
});
