import type { PrismaClient } from '../../generated/prisma/index.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { encrypt } from '../utils/crypto.js';
import { sanitizeTsServerHost, validateTsServerPort } from '../utils/validate-ts-host.js';

export type LocalDevBootstrapEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type LocalDevBootstrapConfig = {
  host: string;
  webqueryPort: number;
  apiKey: string;
  name: string;
  useHttps: boolean;
  sshPort: number;
  sshUsername: string | null;
  sshPassword: string | null;
};

export type LocalDevBootstrapResult =
  | { status: 'skipped'; reason: string }
  | { status: 'exists'; id: number; host: string }
  | { status: 'created'; id: number; host: string };

const DEFAULT_NAME = 'Local TeamSpeak 6';

function truthyGate(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Gate for local-only connection seeding. Requires an explicit enable flag plus
 * a non-empty host and API key so prod/GHCR compose cannot accidentally seed.
 */
export function isLocalDevBootstrapEnabled(env: LocalDevBootstrapEnv = process.env): boolean {
  return Boolean(
    truthyGate(env.LOCAL_DEV_BOOTSTRAP_CONNECTION)
    && env.TS_BOOTSTRAP_HOST?.trim()
    && env.TS_BOOTSTRAP_API_KEY?.trim(),
  );
}

/**
 * Parse bootstrap env into a typed config, or null when the gate refuses.
 * May throw if host/port values are invalid — callers must catch.
 */
export function readLocalDevBootstrapConfig(
  env: LocalDevBootstrapEnv = process.env,
): LocalDevBootstrapConfig | null {
  if (!isLocalDevBootstrapEnabled(env)) return null;

  const host = sanitizeTsServerHost(env.TS_BOOTSTRAP_HOST!);
  const apiKey = env.TS_BOOTSTRAP_API_KEY!.trim();
  const webqueryPort = validateTsServerPort(env.TS_BOOTSTRAP_WEBQUERY_PORT, 10080);
  const sshPort = validateTsServerPort(env.TS_BOOTSTRAP_SSH_PORT, 10022);
  const name = env.TS_BOOTSTRAP_NAME?.trim() || DEFAULT_NAME;
  const useHttps = truthyGate(env.TS_BOOTSTRAP_USE_HTTPS);
  const sshUsername = env.TS_BOOTSTRAP_SSH_USER?.trim() || null;
  const sshPassword = env.TS_BOOTSTRAP_SSH_PASSWORD?.trim() || null;

  return {
    host,
    webqueryPort,
    apiKey,
    name,
    useHttps,
    sshPort,
    sshUsername,
    sshPassword,
  };
}

export type BootstrapLocalDevConnectionOptions = {
  logger?: Pick<Console, 'info' | 'warn'>;
};

/**
 * Idempotently insert a non-demo TsServerConfig for the local pr-test TeamSpeak
 * service and attach it to the connection pool. Failures warn; they never crash boot.
 * Does not block on TeamSpeak readiness — ConnectionPool / UI probes handle that.
 */
export async function bootstrapLocalDevConnection(
  prisma: PrismaClient,
  pool: ConnectionPool,
  env: LocalDevBootstrapEnv = process.env,
  options: BootstrapLocalDevConnectionOptions = {},
): Promise<LocalDevBootstrapResult> {
  const log = options.logger ?? console;

  try {
    if (!isLocalDevBootstrapEnabled(env)) {
      return { status: 'skipped', reason: 'gate_or_credentials_missing' };
    }

    let config: LocalDevBootstrapConfig;
    try {
      const parsed = readLocalDevBootstrapConfig(env);
      if (!parsed) {
        return { status: 'skipped', reason: 'gate_or_credentials_missing' };
      }
      config = parsed;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[bootstrap] Invalid local TeamSpeak bootstrap env; skipping seed: ${message}`);
      return { status: 'skipped', reason: 'invalid_env' };
    }

    const existing = await prisma.tsServerConfig.findFirst({
      where: { host: config.host, isDemo: false },
      select: { id: true, enabled: true },
    });

    if (existing) {
      if (existing.enabled && !pool.hasClient(existing.id)) {
        pool.addClient(existing.id, config.host, config.webqueryPort, config.apiKey, config.useHttps);
      }
      log.info(
        `[bootstrap] Local TeamSpeak connection already present for host ${config.host} (id=${existing.id}); skipping insert`,
      );
      return { status: 'exists', id: existing.id, host: config.host };
    }

    const server = await prisma.tsServerConfig.create({
      data: {
        name: config.name,
        host: config.host,
        webqueryPort: config.webqueryPort,
        apiKey: encrypt(config.apiKey),
        useHttps: config.useHttps,
        sshPort: config.sshPort,
        sshUsername: config.sshUsername,
        sshPassword: config.sshPassword ? encrypt(config.sshPassword) : null,
        enabled: true,
        isDemo: false,
      },
    });

    pool.addClient(server.id, server.host, server.webqueryPort, config.apiKey, server.useHttps);

    // Background credential probe — never delay HTTP listen for TeamSpeak startup.
    try {
      const client = pool.getClient(server.id);
      void client.testConnection()
        .then((result) => {
          if (!result.ok) {
            log.warn(
              `[bootstrap] WebQuery not ready yet for seeded server ${server.id}: ${result.error}`,
            );
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`[bootstrap] WebQuery probe failed for seeded server ${server.id}: ${message}`);
        });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[bootstrap] Could not attach WebQuery probe for seeded server ${server.id}: ${message}`);
    }

    log.info(
      `[bootstrap] Seeded local TeamSpeak connection id=${server.id} host=${server.host} webquery=${server.webqueryPort}`,
    );
    return { status: 'created', id: server.id, host: server.host };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[bootstrap] Failed to seed local TeamSpeak connection: ${message}`);
    return { status: 'skipped', reason: 'error' };
  }
}
