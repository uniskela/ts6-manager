import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  assertIsolatedDatabaseUrl,
  bootstrapIsolatedDiscordDb,
  openIsolatedPrisma,
} from './isolated-db.js';
import { INITIAL_LIVE_SLASH_NAMES } from './integration-readiness.js';
import { previewSlashRegistration } from './slash-registration.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('Discord isolated DB bootstrap (Step 4B)', () => {
  it('pushes schema, finalises nameKey, seeds fixtures; refuses unmarked URLs', async () => {
    assert.throws(() => assertIsolatedDatabaseUrl('file:./data/other.db'), /discord-int-test/);

    const root = await mkdtemp(path.join(tmpdir(), 'ts6-4b-db-'));
    const databaseUrl = `file:${path.join(root, 'discord-int-test.db')}`;
    try {
      const result = await bootstrapIsolatedDiscordDb({ databaseUrl });
      assert.equal(result.hasDiscordGuildBindingTable, true);
      assert.equal(result.fixtures.musicBotId, 10);
      assert.equal(result.fixtures.serverConfigId, 1);

      const { prisma, disconnect } = await openIsolatedPrisma(databaseUrl);
      try {
        const bot = await prisma.musicBot.findUnique({ where: { id: 10 } });
        assert.equal(bot.serverConfigId, 1);
        // Second bootstrap is safe.
        const again = await bootstrapIsolatedDiscordDb({ databaseUrl });
        assert.equal(again.hasDiscordGuildBindingTable, true);
      } finally {
        await disconnect();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('offline registration subset queue/play/stop against simulated fixtures', () => {
    const emptyPath = fileURLToPath(new URL('./fixtures/remote-guild-empty.json', import.meta.url));
    const unrelatedPath = fileURLToPath(new URL('./fixtures/remote-guild-unrelated.json', import.meta.url));
    const empty = JSON.parse(readFileSync(emptyPath, 'utf8'));
    const unrelated = JSON.parse(readFileSync(unrelatedPath, 'utf8'));

    const a = previewSlashRegistration({
      applicationId: '999000000000000001',
      guildId: '111000000000000001',
      remote: empty,
    });
    assert.equal(a.plan.validationErrors.length, 0);
    for (const name of INITIAL_LIVE_SLASH_NAMES) {
      assert.ok(a.plan.create.some((c) => c.name === name), name);
    }
    // /ts is in full create list for empty remote but NOT in the initial live set.
    assert.ok(a.plan.create.some((c) => c.name === 'ts'));
    assert.equal(INITIAL_LIVE_SLASH_NAMES.includes('ts' as any), false);

    const b = previewSlashRegistration({
      applicationId: '999000000000000001',
      guildId: '111000000000000001',
      remote: unrelated,
    });
    assert.ok(b.plan.unrelated.some((c) => c.name === 'labvoice'));
    assert.ok(b.plan.update.some((u) => u.local.name === 'ts'));
    assert.match(b.text, /unrelated\(preserved\)=labvoice/);
    assert.match(b.text, /update=ts/);
    // Fixture JSON is simulated remote state only — plan stays dry-run.
    assert.equal(b.plan.dryRun, true);
    assert.match(JSON.stringify(unrelated), /SIMULATED/);
  });
});
