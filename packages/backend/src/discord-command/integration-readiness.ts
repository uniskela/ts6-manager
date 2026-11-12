/**
 * Discord isolated-integration readiness checks.
 * Reports PRESENT / MISSING / INVALID only — never echoes secret values.
 */

import { isValidDiscordPublicKeyHex } from './interactions-http.js';
import { isDiscordApplicationId } from './discord-delivery.js';
import {
  ISOLATED_DB_BASENAME,
  assessIsolatedSqliteTarget,
} from './isolated-db-target.js';

export {
  ISOLATED_DB_BASENAME,
  assertSafeDatabaseUrlLabel,
  assessIsolatedSqliteTarget,
} from './isolated-db-target.js';

export type ReadinessStatus = 'PRESENT' | 'MISSING' | 'INVALID' | 'DISABLED' | 'OK';

export type ReadinessItem = {
  key: string;
  status: ReadinessStatus;
  note?: string;
};

export type IntegrationReadinessInput = {
  discordApplicationId: string;
  discordPublicKeyHex: string;
  discordBotToken: string;
  discordInstanceId: string;
  discordViewerRoleIds: string[];
  discordAdminRoleIds: string[];
  discordInteractionsEnabled: boolean;
  databaseUrl: string;
  /** Optional operator labels (not secrets). */
  testGuildId?: string;
  testMusicBotId?: string;
  testServerConfigId?: string;
};

const SNOWFLAKE_RE = /^[0-9]{1,32}$/;

export function assessIntegrationReadiness(input: IntegrationReadinessInput): {
  items: ReadinessItem[];
  readyForSupervisedLive: boolean;
  interactionsWouldEnable: boolean;
} {
  const items: ReadinessItem[] = [];

  const app = input.discordApplicationId.trim();
  items.push({
    key: 'DISCORD_APPLICATION_ID',
    status: !app ? 'MISSING' : isDiscordApplicationId(app) ? 'PRESENT' : 'INVALID',
    note: !app ? undefined : isDiscordApplicationId(app) ? undefined : 'not a Discord snowflake',
  });

  const pub = input.discordPublicKeyHex.trim();
  items.push({
    key: 'DISCORD_PUBLIC_KEY',
    status: !pub ? 'MISSING' : isValidDiscordPublicKeyHex(pub) ? 'PRESENT' : 'INVALID',
    note: !pub ? undefined : isValidDiscordPublicKeyHex(pub) ? '64-char hex' : 'must be 64-char hex',
  });

  const token = input.discordBotToken.trim();
  items.push({
    key: 'DISCORD_BOT_TOKEN',
    status: token ? 'PRESENT' : 'MISSING',
    note: 'registration only; value never printed',
  });

  const instance = input.discordInstanceId.trim();
  items.push({
    key: 'DISCORD_INSTANCE_ID',
    status: instance ? 'PRESENT' : 'MISSING',
    note: instance || undefined,
  });

  items.push({
    key: 'DISCORD_VIEWER_ROLE_IDS',
    status: input.discordViewerRoleIds.length === 0
      ? 'MISSING'
      : input.discordViewerRoleIds.every((id) => SNOWFLAKE_RE.test(id))
        ? 'PRESENT'
        : 'INVALID',
    note: `count=${input.discordViewerRoleIds.length}`,
  });

  items.push({
    key: 'DISCORD_ADMIN_ROLE_IDS',
    status: input.discordAdminRoleIds.length === 0
      ? 'MISSING'
      : input.discordAdminRoleIds.every((id) => SNOWFLAKE_RE.test(id))
        ? 'PRESENT'
        : 'INVALID',
    note: `count=${input.discordAdminRoleIds.length}`,
  });

  items.push({
    key: 'DISCORD_INTERACTIONS_ENABLED',
    status: input.discordInteractionsEnabled ? 'PRESENT' : 'DISABLED',
    note: input.discordInteractionsEnabled
      ? 'ON — only during supervised live window'
      : 'off (required for preparation)',
  });

  const db = input.databaseUrl.trim();
  const dbTarget = db ? assessIsolatedSqliteTarget(db) : null;
  items.push({
    key: 'DATABASE_URL',
    status: !db
      ? 'MISSING'
      : dbTarget!.ok
        ? 'PRESENT'
        : 'INVALID',
    note: !db
      ? undefined
      : dbTarget!.ok
        ? `basename=${ISOLATED_DB_BASENAME}`
        : (dbTarget!.errors[0] ?? `basename must be ${ISOLATED_DB_BASENAME}`),
  });

  if (input.testGuildId != null && input.testGuildId !== '') {
    items.push({
      key: 'DISCORD_TEST_GUILD_ID',
      status: SNOWFLAKE_RE.test(input.testGuildId) ? 'PRESENT' : 'INVALID',
    });
  }
  if (input.testMusicBotId != null && input.testMusicBotId !== '') {
    const n = Number(input.testMusicBotId);
    items.push({
      key: 'DISCORD_TEST_MUSIC_BOT_ID',
      status: Number.isInteger(n) && n > 0 ? 'PRESENT' : 'INVALID',
    });
  }
  if (input.testServerConfigId != null && input.testServerConfigId !== '') {
    const n = Number(input.testServerConfigId);
    items.push({
      key: 'DISCORD_TEST_SERVER_CONFIG_ID',
      status: Number.isInteger(n) && n > 0 ? 'PRESENT' : 'INVALID',
    });
  }

  const blocking = items.filter((i) => {
    if (i.key === 'DISCORD_INTERACTIONS_ENABLED') return false;
    return i.status === 'MISSING' || i.status === 'INVALID';
  });

  return {
    items,
    readyForSupervisedLive: blocking.length === 0,
    interactionsWouldEnable: input.discordInteractionsEnabled,
  };
}

export function formatReadinessReport(
  assessment: ReturnType<typeof assessIntegrationReadiness>,
): string {
  const lines = [
    'Discord isolated-integration readiness (no secret values)',
    ...assessment.items.map((i) => {
      const note = i.note ? ` (${i.note})` : '';
      return `- ${i.key}: ${i.status}${note}`;
    }),
    `readyForSupervisedLive=${assessment.readyForSupervisedLive}`,
    `interactionsEnabled=${assessment.interactionsWouldEnable}`,
    'NOTE: config readiness is not Discord remote ownership; HTTPS tunnel not verified here.',
  ];
  return lines.join('\n');
}

/** Initial supervised command set — excludes /ts while presence providers are stubbed. */
export const INITIAL_LIVE_SLASH_NAMES = ['queue', 'play', 'stop'] as const;
