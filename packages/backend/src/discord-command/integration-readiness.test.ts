import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INITIAL_LIVE_SLASH_NAMES,
  assessIntegrationReadiness,
  assertSafeDatabaseUrlLabel,
  formatReadinessReport,
} from './integration-readiness.js';

describe('Discord integration readiness (Step 4B)', () => {
  it('marks isolated DB URLs and reports PRESENT/MISSING/INVALID without secrets', () => {
    assert.equal(assertSafeDatabaseUrlLabel('file:./data/discord-int-test.db'), true);
    assert.equal(assertSafeDatabaseUrlLabel('file:./data/ts6webui.db'), false);
    assert.equal(assertSafeDatabaseUrlLabel('file:./data/evil-discord-int-test.db'), false);

    const bad = assessIntegrationReadiness({
      discordApplicationId: '',
      discordPublicKeyHex: 'abcd',
      discordBotToken: '',
      discordInstanceId: '',
      discordViewerRoleIds: [],
      discordAdminRoleIds: ['not-a-snowflake'],
      discordInteractionsEnabled: false,
      databaseUrl: 'file:./data/prod.db',
    });
    const byKey = Object.fromEntries(bad.items.map((i) => [i.key, i]));
    assert.equal(byKey.DISCORD_APPLICATION_ID.status, 'MISSING');
    assert.equal(byKey.DISCORD_PUBLIC_KEY.status, 'INVALID');
    assert.equal(byKey.DISCORD_BOT_TOKEN.status, 'MISSING');
    assert.equal(byKey.DISCORD_ADMIN_ROLE_IDS.status, 'INVALID');
    assert.equal(byKey.DATABASE_URL.status, 'INVALID');
    assert.equal(byKey.DISCORD_INTERACTIONS_ENABLED.status, 'DISABLED');
    assert.equal(bad.readyForSupervisedLive, false);
    const text = formatReadinessReport(bad);
    assert.doesNotMatch(text, /super-secret|sk_live|Bot [A-Za-z0-9._-]{10,}/);
    assert.match(text, /DISCORD_PUBLIC_KEY: INVALID/);

    const ok = assessIntegrationReadiness({
      discordApplicationId: '999000000000000001',
      discordPublicKeyHex: 'a'.repeat(64),
      discordBotToken: 'super-secret-should-not-appear',
      discordInstanceId: 'discord-int-test',
      discordViewerRoleIds: ['111'],
      discordAdminRoleIds: ['222'],
      discordInteractionsEnabled: false,
      databaseUrl: 'file:./data/discord-int-test.db',
    });
    assert.equal(ok.readyForSupervisedLive, true);
    assert.doesNotMatch(formatReadinessReport(ok), /super-secret-should-not-appear/);
    assert.deepEqual([...INITIAL_LIVE_SLASH_NAMES], ['queue', 'play', 'stop']);
  });
});
