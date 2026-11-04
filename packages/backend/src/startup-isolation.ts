/**
 * Narrow isolation gate for Discord Commands & Radio Step 4C local backends.
 * Off by default — production / normal development behaviour unchanged.
 */
import {
  assessIsolatedSqliteTarget,
  ISOLATED_DB_BASENAME,
} from './discord-command/isolated-db-target.js';
import { isDiscordApplicationId } from './discord-command/discord-delivery.js';
import { isValidDiscordPublicKeyHex } from './discord-command/interactions-http.js';
import { isLoopbackListenHost, resolveListenHost } from './listen-host.js';

export type IsolatedIntegrationAssessment = {
  enabled: boolean;
  ok: boolean;
  errors: string[];
  skipBackgroundJobs: boolean;
  listenHost: string | undefined;
  liveInteractionsLatch: boolean;
};

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return v === '1' || v === 'true';
}

/** Explicit opt-in for the isolated Discord integration test process. */
export function isIsolatedIntegrationMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, 'TS6_ISOLATED_INTEGRATION');
}

/**
 * Second latch: allows DISCORD_INTERACTIONS_ENABLED under isolated mode only when
 * the disposable DB, loopback bind, and pinned test application identity all match.
 * Default off.
 */
export function isIsolatedLiveInteractionsLatch(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, 'TS6_ISOLATED_LIVE_INTERACTIONS');
}

function pushIsolatedBaseErrors(env: NodeJS.ProcessEnv, errors: string[]): void {
  const databaseUrl = (env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    errors.push('TS6_ISOLATED_INTEGRATION requires DATABASE_URL (no default ts6webui.db fallback)');
  } else {
    const db = assessIsolatedSqliteTarget(databaseUrl);
    if (!db.ok) {
      errors.push(
        db.errors[0]
          ?? `DATABASE_URL must resolve to basename ${ISOLATED_DB_BASENAME}`,
      );
    }
  }

  if (!isLoopbackListenHost(resolveListenHost(env))) {
    errors.push(
      'TS6_ISOLATED_INTEGRATION requires LISTEN_HOST=127.0.0.1 (or ::1 / localhost)',
    );
  }
}

function pushLiveInteractionsErrors(env: NodeJS.ProcessEnv, errors: string[]): void {
  const appId = (env.DISCORD_APPLICATION_ID || '').trim();
  const pinned = (env.DISCORD_TEST_APPLICATION_ID || '').trim();
  const productionId = (env.DISCORD_PRODUCTION_APPLICATION_ID || '').trim();
  const publicKey = (env.DISCORD_PUBLIC_KEY || '').trim();

  if (!pinned) {
    errors.push(
      'TS6_ISOLATED_LIVE_INTERACTIONS requires DISCORD_TEST_APPLICATION_ID (pinned test application)',
    );
  } else if (!isDiscordApplicationId(pinned)) {
    errors.push('DISCORD_TEST_APPLICATION_ID must be a Discord application snowflake');
  }

  if (!appId) {
    errors.push('TS6_ISOLATED_LIVE_INTERACTIONS requires DISCORD_APPLICATION_ID');
  } else if (!isDiscordApplicationId(appId)) {
    errors.push('DISCORD_APPLICATION_ID must be a Discord application snowflake');
  } else if (pinned && appId !== pinned) {
    errors.push(
      'DISCORD_APPLICATION_ID must equal DISCORD_TEST_APPLICATION_ID under live isolated interactions',
    );
  }

  if (productionId && appId && appId === productionId) {
    errors.push(
      'DISCORD_APPLICATION_ID matches DISCORD_PRODUCTION_APPLICATION_ID — production identity refused',
    );
  }

  if (!publicKey) {
    errors.push('TS6_ISOLATED_LIVE_INTERACTIONS requires DISCORD_PUBLIC_KEY');
  } else if (!isValidDiscordPublicKeyHex(publicKey)) {
    errors.push('DISCORD_PUBLIC_KEY must be 64-char hex');
  }
}

/**
 * When TS6_ISOLATED_INTEGRATION is on:
 * - DATABASE_URL must be the disposable discord-int-test.db (no ts6webui.db fallback)
 * - LISTEN_HOST (or HOST) must be loopback
 * - DISCORD_INTERACTIONS_ENABLED requires TS6_ISOLATED_LIVE_INTERACTIONS=1 plus pinned test app
 * Background job skips apply for that mode only.
 */
export function assessIsolatedIntegrationStartup(
  env: NodeJS.ProcessEnv = process.env,
): IsolatedIntegrationAssessment {
  const enabled = isIsolatedIntegrationMode(env);
  const listenHost = resolveListenHost(env);
  const liveLatch = isIsolatedLiveInteractionsLatch(env);
  const errors: string[] = [];

  if (!enabled) {
    return {
      enabled: false,
      ok: true,
      errors: [],
      skipBackgroundJobs: false,
      listenHost,
      liveInteractionsLatch: liveLatch,
    };
  }

  pushIsolatedBaseErrors(env, errors);

  const interactionsOn = envFlag(env, 'DISCORD_INTERACTIONS_ENABLED');
  if (interactionsOn) {
    if (!liveLatch) {
      errors.push(
        'DISCORD_INTERACTIONS_ENABLED requires TS6_ISOLATED_LIVE_INTERACTIONS=1 under TS6_ISOLATED_INTEGRATION',
      );
    } else {
      pushLiveInteractionsErrors(env, errors);
    }
  } else if (liveLatch) {
    // Latch may be prepared before the supervised window; still validate identity early.
    pushLiveInteractionsErrors(env, errors);
  }

  return {
    enabled: true,
    ok: errors.length === 0,
    errors,
    skipBackgroundJobs: true,
    listenHost,
    liveInteractionsLatch: liveLatch,
  };
}

export function assertIsolatedIntegrationStartup(
  env: NodeJS.ProcessEnv = process.env,
): IsolatedIntegrationAssessment {
  const assessment = assessIsolatedIntegrationStartup(env);
  if (assessment.enabled && !assessment.ok) {
    throw new Error(
      `[FATAL] Isolated integration startup refused:\n- ${assessment.errors.join('\n- ')}`,
    );
  }
  return assessment;
}
