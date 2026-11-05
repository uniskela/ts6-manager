import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessIsolatedIntegrationStartup,
  assertIsolatedIntegrationStartup,
  isIsolatedIntegrationMode,
  isIsolatedLiveInteractionsLatch,
  shouldEnableIsolatedLiveAdministratorGrant,
} from './startup-isolation.js';

const isolatedDb = 'file:/tmp/discord-int-test.db';
const TEST_APP = '123456789012345678';
const PROD_APP = '999999999999999999';
const PUB = 'a'.repeat(64);

test('isolated mode off by default — production-compatible', () => {
  assert.equal(isIsolatedIntegrationMode({}), false);
  assert.equal(isIsolatedLiveInteractionsLatch({}), false);
  const a = assessIsolatedIntegrationStartup({
    DATABASE_URL: 'file:./data/ts6webui.db',
  });
  assert.equal(a.enabled, false);
  assert.equal(a.ok, true);
  assert.equal(a.skipBackgroundJobs, false);
});

test('isolated mode requires disposable DB + loopback listen', () => {
  const bad = assessIsolatedIntegrationStartup({
    TS6_ISOLATED_INTEGRATION: '1',
    DATABASE_URL: 'file:./data/ts6webui.db',
  });
  assert.equal(bad.enabled, true);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /ts6webui|basename|DATABASE_URL/i.test(e)));

  const noHost = assessIsolatedIntegrationStartup({
    TS6_ISOLATED_INTEGRATION: 'true',
    DATABASE_URL: isolatedDb,
  });
  assert.equal(noHost.ok, false);
  assert.ok(noHost.errors.some((e) => /LISTEN_HOST/i.test(e)));

  const ok = assessIsolatedIntegrationStartup({
    TS6_ISOLATED_INTEGRATION: '1',
    DATABASE_URL: isolatedDb,
    LISTEN_HOST: '127.0.0.1',
    DISCORD_INTERACTIONS_ENABLED: 'false',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.skipBackgroundJobs, true);
  assert.equal(ok.listenHost, '127.0.0.1');
  assert.equal(ok.liveInteractionsLatch, false);
});

test('isolated mode refuses interactions without live latch', () => {
  const a = assessIsolatedIntegrationStartup({
    TS6_ISOLATED_INTEGRATION: '1',
    DATABASE_URL: isolatedDb,
    LISTEN_HOST: '127.0.0.1',
    DISCORD_INTERACTIONS_ENABLED: 'true',
  });
  assert.equal(a.ok, false);
  assert.ok(a.errors.some((e) => /TS6_ISOLATED_LIVE_INTERACTIONS/i.test(e)));
});

test('live latch allows interactions when identity + key + db + loopback match', () => {
  const a = assessIsolatedIntegrationStartup({
    TS6_ISOLATED_INTEGRATION: '1',
    TS6_ISOLATED_LIVE_INTERACTIONS: '1',
    DATABASE_URL: isolatedDb,
    LISTEN_HOST: '127.0.0.1',
    DISCORD_INTERACTIONS_ENABLED: 'true',
    DISCORD_APPLICATION_ID: TEST_APP,
    DISCORD_TEST_APPLICATION_ID: TEST_APP,
    DISCORD_PUBLIC_KEY: PUB,
  });
  assert.equal(a.ok, true);
  assert.equal(a.liveInteractionsLatch, true);
  assert.equal(a.skipBackgroundJobs, true);
});

test('live latch rejects mismatched or production application identity', () => {
  const mismatch = assessIsolatedIntegrationStartup({
    TS6_ISOLATED_INTEGRATION: '1',
    TS6_ISOLATED_LIVE_INTERACTIONS: '1',
    DATABASE_URL: isolatedDb,
    LISTEN_HOST: '127.0.0.1',
    DISCORD_INTERACTIONS_ENABLED: 'true',
    DISCORD_APPLICATION_ID: TEST_APP,
    DISCORD_TEST_APPLICATION_ID: '111111111111111111',
    DISCORD_PUBLIC_KEY: PUB,
  });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.some((e) => /must equal DISCORD_TEST_APPLICATION_ID/i.test(e)));

  const prod = assessIsolatedIntegrationStartup({
    TS6_ISOLATED_INTEGRATION: '1',
    TS6_ISOLATED_LIVE_INTERACTIONS: '1',
    DATABASE_URL: isolatedDb,
    LISTEN_HOST: '127.0.0.1',
    DISCORD_INTERACTIONS_ENABLED: 'true',
    DISCORD_APPLICATION_ID: PROD_APP,
    DISCORD_TEST_APPLICATION_ID: PROD_APP,
    DISCORD_PRODUCTION_APPLICATION_ID: PROD_APP,
    DISCORD_PUBLIC_KEY: PUB,
  });
  assert.equal(prod.ok, false);
  assert.ok(prod.errors.some((e) => /production identity refused/i.test(e)));
});

test('live latch requires public key', () => {
  const a = assessIsolatedIntegrationStartup({
    TS6_ISOLATED_INTEGRATION: '1',
    TS6_ISOLATED_LIVE_INTERACTIONS: '1',
    DATABASE_URL: isolatedDb,
    LISTEN_HOST: '127.0.0.1',
    DISCORD_INTERACTIONS_ENABLED: 'true',
    DISCORD_APPLICATION_ID: TEST_APP,
    DISCORD_TEST_APPLICATION_ID: TEST_APP,
  });
  assert.equal(a.ok, false);
  assert.ok(a.errors.some((e) => /PUBLIC_KEY/i.test(e)));
});

test('Administrator grant requires both isolation latches', () => {
  assert.equal(shouldEnableIsolatedLiveAdministratorGrant({}), false);
  assert.equal(shouldEnableIsolatedLiveAdministratorGrant({
    TS6_ISOLATED_INTEGRATION: '1',
  }), false);
  assert.equal(shouldEnableIsolatedLiveAdministratorGrant({
    TS6_ISOLATED_LIVE_INTERACTIONS: '1',
  }), false);
  assert.equal(shouldEnableIsolatedLiveAdministratorGrant({
    TS6_ISOLATED_INTEGRATION: '1',
    TS6_ISOLATED_LIVE_INTERACTIONS: '1',
  }), true);
});

test('assertIsolatedIntegrationStartup throws when refused', () => {
  assert.throws(
    () => assertIsolatedIntegrationStartup({
      TS6_ISOLATED_INTEGRATION: '1',
      DATABASE_URL: 'file:./data/ts6webui.db',
      LISTEN_HOST: '127.0.0.1',
    }),
    /FATAL|refused|ts6webui/i,
  );
  assert.doesNotThrow(() => assertIsolatedIntegrationStartup({}));
});
