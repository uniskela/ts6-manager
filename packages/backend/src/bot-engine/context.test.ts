import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutionContext } from './context.js';

test('UTC announcement placeholders use UTC on a host in another timezone', async (t) => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 11, 3, 30) });
  try {
    const ctx = new ExecutionContext({} as any, 1, 1, 1, 1, 'cron', {}, 'UTC');
    assert.equal(await ctx.resolveTemplate('{{time.date}} {{time.time}}'), '11.10.2026 03:30');
    t.mock.timers.setTime(Date.UTC(2026, 9, 11, 0, 15));
    assert.equal(await ctx.resolveTemplate('{{time.time}}'), '00:15');
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
