import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  bootstrapLocalDevConnection,
  isLocalDevBootstrapEnabled,
  readLocalDevBootstrapConfig,
} from './local-dev-connection.js';
import { decrypt } from '../utils/crypto.js';

const PREV_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || randomBytes(32).toString('base64');
});

afterEach(() => {
  if (PREV_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = PREV_ENCRYPTION_KEY;
});

describe('isLocalDevBootstrapEnabled', () => {
  it('refuses when gate is unset', () => {
    assert.equal(
      isLocalDevBootstrapEnabled({
        TS_BOOTSTRAP_HOST: 'teamspeak',
        TS_BOOTSTRAP_API_KEY: 'key',
      }),
      false,
    );
  });

  it('refuses when gate is off', () => {
    assert.equal(
      isLocalDevBootstrapEnabled({
        LOCAL_DEV_BOOTSTRAP_CONNECTION: '0',
        TS_BOOTSTRAP_HOST: 'teamspeak',
        TS_BOOTSTRAP_API_KEY: 'key',
      }),
      false,
    );
  });

  it('refuses when API key is missing', () => {
    assert.equal(
      isLocalDevBootstrapEnabled({
        LOCAL_DEV_BOOTSTRAP_CONNECTION: '1',
        TS_BOOTSTRAP_HOST: 'teamspeak',
        TS_BOOTSTRAP_API_KEY: '  ',
      }),
      false,
    );
  });

  it('refuses when host is missing', () => {
    assert.equal(
      isLocalDevBootstrapEnabled({
        LOCAL_DEV_BOOTSTRAP_CONNECTION: 'true',
        TS_BOOTSTRAP_API_KEY: 'key',
      }),
      false,
    );
  });

  it('allows when gate and credentials are set', () => {
    assert.equal(
      isLocalDevBootstrapEnabled({
        LOCAL_DEV_BOOTSTRAP_CONNECTION: '1',
        TS_BOOTSTRAP_HOST: 'teamspeak',
        TS_BOOTSTRAP_API_KEY: 'key',
      }),
      true,
    );
  });
});

describe('readLocalDevBootstrapConfig', () => {
  it('returns null when gated off', () => {
    assert.equal(readLocalDevBootstrapConfig({}), null);
  });

  it('parses ports, SSH fields, and defaults', () => {
    const config = readLocalDevBootstrapConfig({
      LOCAL_DEV_BOOTSTRAP_CONNECTION: '1',
      TS_BOOTSTRAP_HOST: 'teamspeak',
      TS_BOOTSTRAP_API_KEY: 'secret-key',
      TS_BOOTSTRAP_SSH_USER: 'serveradmin',
      TS_BOOTSTRAP_SSH_PASSWORD: 'testadmin',
    });
    assert.ok(config);
    assert.equal(config!.host, 'teamspeak');
    assert.equal(config!.webqueryPort, 10080);
    assert.equal(config!.sshPort, 10022);
    assert.equal(config!.apiKey, 'secret-key');
    assert.equal(config!.name, 'Local TeamSpeak 6');
    assert.equal(config!.sshUsername, 'serveradmin');
    assert.equal(config!.sshPassword, 'testadmin');
    assert.equal(config!.useHttps, false);
  });

  it('throws on invalid webquery port', () => {
    assert.throws(
      () => readLocalDevBootstrapConfig({
        LOCAL_DEV_BOOTSTRAP_CONNECTION: '1',
        TS_BOOTSTRAP_HOST: 'teamspeak',
        TS_BOOTSTRAP_API_KEY: 'key',
        TS_BOOTSTRAP_WEBQUERY_PORT: 'not-a-port',
      }),
    );
  });
});

describe('bootstrapLocalDevConnection', () => {
  function makeEnv(overrides: Record<string, string | undefined> = {}) {
    return {
      LOCAL_DEV_BOOTSTRAP_CONNECTION: '1',
      TS_BOOTSTRAP_HOST: 'teamspeak',
      TS_BOOTSTRAP_API_KEY: 'bootstrap-api-key',
      TS_BOOTSTRAP_SSH_USER: 'serveradmin',
      TS_BOOTSTRAP_SSH_PASSWORD: 'testadmin',
      ...overrides,
    };
  }

  function makePool(overrides: Partial<{
    hasClient: (id: number) => boolean;
    addClient: (...args: any[]) => void;
    getClient: (id: number) => { testConnection: () => Promise<{ ok: boolean; error?: string }> };
  }> = {}) {
    return {
      hasClient: () => false,
      addClient: () => {},
      getClient: () => ({
        testConnection: async () => ({ ok: true }),
      }),
      ...overrides,
    };
  }

  it('skips when gate is disabled', async () => {
    const result = await bootstrapLocalDevConnection(
      { tsServerConfig: { findFirst: async () => { throw new Error('should not query'); } } } as any,
      makePool({ addClient: () => { throw new Error('should not add'); } }) as any,
      makeEnv({ LOCAL_DEV_BOOTSTRAP_CONNECTION: '0' }),
      { logger: { info() {}, warn() {} } },
    );
    assert.deepEqual(result, { status: 'skipped', reason: 'gate_or_credentials_missing' });
  });

  it('skips without crashing when bootstrap env is invalid', async () => {
    const warnings: string[] = [];
    const result = await bootstrapLocalDevConnection(
      { tsServerConfig: { findFirst: async () => { throw new Error('should not query'); } } } as any,
      makePool() as any,
      makeEnv({ TS_BOOTSTRAP_WEBQUERY_PORT: '99999' }),
      { logger: { info() {}, warn(msg: string) { warnings.push(msg); } } },
    );
    assert.deepEqual(result, { status: 'skipped', reason: 'invalid_env' });
    assert.ok(warnings.some((w) => w.includes('Invalid local TeamSpeak bootstrap env')));
  });

  it('inserts an encrypted non-demo connection and attaches the pool', async () => {
    let created: any;
    const added: Array<{ id: number; host: string; port: number; key: string }> = [];
    const prisma = {
      tsServerConfig: {
        findFirst: async () => null,
        create: async ({ data }: any) => {
          created = { id: 42, ...data };
          return created;
        },
      },
    };
    const pool = makePool({
      addClient: (id: number, host: string, port: number, key: string) => {
        added.push({ id, host, port, key });
      },
    });

    const result = await bootstrapLocalDevConnection(
      prisma as any,
      pool as any,
      makeEnv(),
      { logger: { info() {}, warn() {} } },
    );

    assert.equal(result.status, 'created');
    if (result.status === 'created') {
      assert.equal(result.id, 42);
      assert.equal(result.host, 'teamspeak');
    }
    assert.equal(created.isDemo, false);
    assert.equal(created.host, 'teamspeak');
    assert.equal(created.webqueryPort, 10080);
    assert.equal(created.sshUsername, 'serveradmin');
    assert.equal(decrypt(created.apiKey), 'bootstrap-api-key');
    assert.equal(decrypt(created.sshPassword), 'testadmin');
    assert.deepEqual(added, [{ id: 42, host: 'teamspeak', port: 10080, key: 'bootstrap-api-key' }]);
  });

  it('is idempotent when a non-demo row for the host already exists', async () => {
    let createCalls = 0;
    const prisma = {
      tsServerConfig: {
        findFirst: async () => ({ id: 7, enabled: true }),
        create: async () => {
          createCalls += 1;
          throw new Error('should not create');
        },
      },
    };
    const pool = makePool({
      hasClient: (id: number) => id === 7,
      addClient: () => { throw new Error('should not re-add when already pooled'); },
    });

    const first = await bootstrapLocalDevConnection(
      prisma as any,
      pool as any,
      makeEnv(),
      { logger: { info() {}, warn() {} } },
    );
    const second = await bootstrapLocalDevConnection(
      prisma as any,
      pool as any,
      makeEnv(),
      { logger: { info() {}, warn() {} } },
    );

    assert.deepEqual(first, { status: 'exists', id: 7, host: 'teamspeak' });
    assert.deepEqual(second, { status: 'exists', id: 7, host: 'teamspeak' });
    assert.equal(createCalls, 0);
  });

  it('does not crash boot when insert fails', async () => {
    const warnings: string[] = [];
    const result = await bootstrapLocalDevConnection(
      {
        tsServerConfig: {
          findFirst: async () => null,
          create: async () => { throw new Error('db down'); },
        },
      } as any,
      makePool() as any,
      makeEnv(),
      { logger: { info() {}, warn(msg: string) { warnings.push(msg); } } },
    );
    assert.deepEqual(result, { status: 'skipped', reason: 'error' });
    assert.ok(warnings.some((w) => w.includes('db down')));
  });
});
