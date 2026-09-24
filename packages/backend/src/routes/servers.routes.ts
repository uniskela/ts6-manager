import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError, TeamSpeakFloodError } from '../middleware/error-handler.js';
import { createWebQueryClient } from '../ts-client/webquery-client.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { testSshConnection } from '../utils/ssh-test.js';
import { reloadEnabledServerFlows } from './server-connection-refresh.js';
import {
  assertResolvableTsServerHost,
  sanitizeTsServerHost,
  validateTsServerPort,
} from '../utils/validate-ts-host.js';
import {
  buildFloodDiagnosticReport,
  buildFullSuccessReport,
} from '../ts-client/connection-diagnostics.js';
import { DEFAULT_METRICS_PORT } from '../ts-client/metrics-client.js';
import {
  actorFromRequest,
  markPartial,
  recordLocalSuccess,
} from '../audit/index.js';
import type { AdminAuditAction } from '@ts6/common';

function parseOptionalMetricsHost(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return sanitizeTsServerHost(String(value));
}

function metricsAdminFields(server: {
  metricsEnabled?: boolean | null;
  metricsPort?: number | null;
  metricsHost?: string | null;
}) {
  return {
    metricsEnabled: Boolean(server.metricsEnabled),
    metricsPort: server.metricsPort ?? DEFAULT_METRICS_PORT,
    metricsHost: server.metricsHost ?? null,
  };
}

function throwIfSharedQueryFlooded(req: Request, configId: number): void {
  const pool: ConnectionPool | undefined = req.app.locals.connectionPool;
  if (!pool) return;
  try {
    const client = pool.getClient(configId);
    const remainingMs = client.getFloodCooldownRemainingMs();
    if (remainingMs > 0) {
      throw new TeamSpeakFloodError(Math.max(1, Math.ceil(remainingMs / 1000)));
    }
  } catch (err) {
    if (err instanceof TeamSpeakFloodError) throw err;
    // Missing/disabled pool entries still fall through to a fresh probe.
  }
}

export const serverRoutes: Router = Router();

// Deployment self-check for the connection setup wizard (must be before /:configId routes)
serverRoutes.get('/deployment-check', requireRole('admin'), async (_req: Request, res: Response, next) => {
  try {
    const { detectDeploymentScenario } = await import('../utils/detect-deployment.js');
    const result = await detectDeploymentScenario();
    res.json(result);
  } catch (err) { next(err); }
});

// Create or restore the generic in-process demo server. No DNS lookup, socket,
// WebQuery request, SSH connection, or user-provided environment data is used.
serverRoutes.post('/demo', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const pool: ConnectionPool = req.app.locals.connectionPool;

    const existing = await prisma.tsServerConfig.findFirst({ where: { isDemo: true } });
    if (existing) {
      if (existing.enabled && !pool.hasClient(existing.id)) {
        pool.addDemoClient(existing.id);
      }
      res.json({ id: existing.id, name: existing.name, isDemo: true, existing: true });
      return;
    }

    const server = await prisma.tsServerConfig.create({
      data: {
        name: 'Demo TeamSpeak Server',
        host: 'demo.invalid',
        webqueryPort: 10080,
        apiKey: encrypt('demo-mode-not-a-real-api-key'),
        useHttps: false,
        sshPort: 10022,
        enabled: true,
        isDemo: true,
      },
    });

    pool.addDemoClient(server.id);
    res.status(201).json({ id: server.id, name: server.name, isDemo: true, existing: false });
  } catch (err) { next(err); }
});

// List all configured TS server connections
serverRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const isAdmin = req.user?.role === 'admin';
    const servers = await prisma.tsServerConfig.findMany({
      select: {
        id: true, name: true, host: true, webqueryPort: true,
        useHttps: true, sshPort: true, enabled: true, isDemo: true,
        createdAt: true, sshUsername: true, sshPassword: true,
        metricsEnabled: true, metricsPort: true, metricsHost: true,
      },
      orderBy: { id: 'asc' },
    });

    res.json(servers.map((s: any) => {
      const base = {
        ...s,
        hasSshCredentials: !!s.sshUsername && !!s.sshPassword,
        sshUsername: undefined,
        sshPassword: undefined,
        metricsEnabled: undefined,
        metricsPort: undefined,
        metricsHost: undefined,
      };
      return isAdmin ? { ...base, ...metricsAdminFields(s) } : base;
    }));
  } catch (err) { next(err); }
});

// Add new TS server connection
serverRoutes.post('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const {
      name, host, webqueryPort, apiKey, useHttps, sshPort, sshUsername, sshPassword,
      metricsEnabled, metricsPort, metricsHost,
    } = req.body;
    if (!name || !host || !apiKey) throw new AppError(400, 'Name, host, and API key are required');

    const safeHost = sanitizeTsServerHost(host);
    const safeWebqueryPort = validateTsServerPort(webqueryPort, 10080);
    const safeSshPort = validateTsServerPort(sshPort, 10022);
    const safeMetricsPort = validateTsServerPort(metricsPort, DEFAULT_METRICS_PORT);
    const safeMetricsHost = parseOptionalMetricsHost(metricsHost);
    const metricsOn = Boolean(metricsEnabled);

    const prisma = req.app.locals.prisma;
    // H8: Encrypt sensitive fields at rest — never put apiKey/sshPassword in audit
    const { result: server, operationId } = await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'connection.create',
        target: { type: 'connection' },
      },
      async (tx) => tx.tsServerConfig.create({
        data: {
          name,
          host: safeHost,
          webqueryPort: safeWebqueryPort,
          apiKey: encrypt(apiKey),
          useHttps: useHttps || false,
          sshPort: safeSshPort,
          sshUsername: sshUsername || null,
          sshPassword: sshPassword ? encrypt(sshPassword) : null,
          metricsEnabled: metricsOn,
          metricsPort: safeMetricsPort,
          metricsHost: safeMetricsHost === undefined ? null : safeMetricsHost,
        },
      }),
      { resolveTargetId: (created) => created.id },
    );

    await prisma.adminAuditEvent.updateMany({
      where: { operationId },
      data: { connectionId: server.id },
    });

    // Add to connection pool (use plaintext key for connection)
    const pool: ConnectionPool = req.app.locals.connectionPool;
    try {
      pool.addClient(server.id, server.host, server.webqueryPort, apiKey, server.useHttps);
      pool.syncMetricsClient(server);
    } catch {
      await markPartial(prisma, operationId, 'pool_refresh_failed');
    }

    res.status(201).json({ id: server.id, name: server.name });
  } catch (err) { next(err); }
});

// Get server connection details
serverRoutes.get('/:configId', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const server = await prisma.tsServerConfig.findUnique({
      where: { id: parseInt(String(req.params.configId)) },
    });
    if (!server) throw new AppError(404, 'Server config not found');

    const payload: Record<string, unknown> = {
      id: server.id, name: server.name, host: server.host,
      webqueryPort: server.webqueryPort, useHttps: server.useHttps,
      sshPort: server.sshPort, hasSshCredentials: !!server.sshUsername && !!server.sshPassword,
      enabled: server.enabled, isDemo: server.isDemo, createdAt: server.createdAt,
    };
    if (req.user?.role === 'admin') {
      Object.assign(payload, metricsAdminFields(server));
    }
    res.json(payload);
  } catch (err) { next(err); }
});

// Update server connection
serverRoutes.put('/:configId', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.configId));
    const data: any = {};

    const fields = [
      'name', 'host', 'webqueryPort', 'apiKey', 'useHttps', 'sshPort', 'sshUsername', 'sshPassword', 'enabled',
      'metricsEnabled', 'metricsPort', 'metricsHost',
    ];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        // Don't overwrite secrets/SSH username with empty strings (edit form omits unchanged secrets)
        if ((field === 'apiKey' || field === 'sshPassword' || field === 'sshUsername') && req.body[field] === '') continue;
        if (field === 'host') {
          data[field] = sanitizeTsServerHost(req.body[field]);
          continue;
        }
        if (field === 'webqueryPort') {
          data[field] = validateTsServerPort(req.body[field], 10080);
          continue;
        }
        if (field === 'sshPort') {
          data[field] = validateTsServerPort(req.body[field], 10022);
          continue;
        }
        if (field === 'metricsPort') {
          data[field] = validateTsServerPort(req.body[field], DEFAULT_METRICS_PORT);
          continue;
        }
        if (field === 'metricsHost') {
          const parsed = parseOptionalMetricsHost(req.body[field]);
          if (parsed !== undefined) data[field] = parsed;
          continue;
        }
        if (field === 'metricsEnabled') {
          data[field] = Boolean(req.body[field]);
          continue;
        }
        // H8: Encrypt sensitive fields
        if (field === 'apiKey' || field === 'sshPassword') {
          data[field] = encrypt(req.body[field]);
        } else {
          data[field] = req.body[field];
        }
      }
    }

    const credentialsChanged = Boolean(
      (req.body.apiKey && req.body.apiKey !== '')
      || (req.body.sshPassword && req.body.sshPassword !== ''),
    );
    const action: AdminAuditAction = credentialsChanged
      ? 'connection.credentials_changed'
      : 'connection.update';

    const { result: server, operationId } = await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action,
        connectionId: id,
        target: { type: 'connection', id },
      },
      async (tx) => tx.tsServerConfig.update({ where: { id }, data }),
    );

    // Refresh WebQuery connection pool (destroy old sockets first)
    const pool: ConnectionPool = req.app.locals.connectionPool;
    try {
      await pool.refreshClient(id);
    } catch {
      await markPartial(prisma, operationId, 'pool_refresh_failed');
    }

    // Force EventBridge SSH reconnect so updated SSH credentials take effect.
    // Then reload flows using this server so long-running actions/animations stop
    // holding the destroyed WebQuery client from before the refresh.
    const botEngine = req.app.locals.botEngine;
    try {
      if (botEngine?.getEventBridge) {
        await botEngine.getEventBridge().reconnectConfig(id);
      }
      if (botEngine?.reloadFlow) {
        await reloadEnabledServerFlows(prisma, botEngine, id);
      }
    } catch {
      await markPartial(prisma, operationId, 'engine_reload_failed');
    }

    res.json({ id: server.id, name: server.name });
  } catch (err) { next(err); }
});

// Delete server connection
serverRoutes.delete('/:configId', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.configId));
    // Release journal SSH ownership and purge journal rows before deleting the config.
    const activityJournal = req.app.locals.activityJournal;
    if (activityJournal?.releaseConfig) {
      await activityJournal.releaseConfig(id);
    }

    await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'connection.delete',
        connectionId: id,
        target: { type: 'connection', id },
      },
      async (tx) => {
        await tx.tsServerConfig.delete({ where: { id } });
      },
    );

    const pool: ConnectionPool = req.app.locals.connectionPool;
    pool.removeClient(id);

    res.status(204).send();
  } catch (err) { next(err); }
});

// Test WebQuery with draft credentials (not persisted) — staged diagnostics (#91 Slice 2)
serverRoutes.post('/test-webquery', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const { host, webqueryPort, apiKey, useHttps } = req.body;
    if (!host || !apiKey) throw new AppError(400, 'Host and API key are required');

    const safeHost = await assertResolvableTsServerHost(host);
    const safePort = validateTsServerPort(webqueryPort, 10080);

    const client = createWebQueryClient(safeHost, safePort, apiKey, useHttps || false);
    try {
      // Always probe default virtual server 1 — do not accept request-body sid
      // (would taint the WebQuery path / re-open CodeQL request-forgery).
      const report = await client.diagnoseConnection();
      // Always HTTP 200 so the UI can render partial stage results.
      res.json(report);
    } finally {
      client.destroy();
    }
  } catch (err) { next(err); }
});

// Test SSH with draft credentials (not persisted)
serverRoutes.post('/test-ssh', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const { host, sshPort, sshUsername, sshPassword } = req.body;
    const safeHost = await assertResolvableTsServerHost(host);
    const result = await testSshConnection({
      host: safeHost,
      port: validateTsServerPort(sshPort, 10022),
      username: sshUsername,
      password: sshPassword,
    });

    if (!result.ok) {
      return res.status(502).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Test connection — staged diagnostics (#91 Slice 2); SSH endpoints stay binary
serverRoutes.post('/:configId/test', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(String(req.params.configId));
    const server = await prisma.tsServerConfig.findUnique({
      where: { id: configId },
    });
    if (!server) throw new AppError(404, 'Server config not found');
    if (server.isDemo) {
      res.json(buildFullSuccessReport('Demo mode'));
      return;
    }

    try {
      throwIfSharedQueryFlooded(req, configId);
    } catch (err) {
      if (err instanceof TeamSpeakFloodError) {
        res.json(buildFloodDiagnosticReport(err.retryAfterSeconds));
        return;
      }
      throw err;
    }

    const client = createWebQueryClient(server.host, server.webqueryPort, decrypt(server.apiKey), server.useHttps);
    try {
      // Default virtual server 1 only — selected-sid belongs on persisted config later.
      const report = await client.diagnoseConnection();
      res.json(report);
    } finally {
      client.destroy(); // Close the temporary TCP connection immediately
    }
  } catch (err) { next(err); }
});

// Test SSH for an existing connection
serverRoutes.post('/:configId/test-ssh', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(String(req.params.configId));
    const server = await prisma.tsServerConfig.findUnique({
      where: { id: configId },
    });
    if (!server) throw new AppError(404, 'Server config not found');
    if (server.isDemo) {
      throw new AppError(400, 'SSH is not available for demo servers');
    }
    if (!server.sshUsername || !server.sshPassword) {
      throw new AppError(400, 'SSH credentials not configured');
    }

    // Shared WebQuery flood cooldown means TeamSpeak is still blocking this manager
    // source address — a fresh SSH Query probe would only deepen the ban window.
    throwIfSharedQueryFlooded(req, configId);

    const result = await testSshConnection({
      host: server.host,
      port: server.sshPort,
      username: server.sshUsername,
      password: decrypt(server.sshPassword),
      hostKeyFingerprint: server.sshHostKeyFingerprint,
    });

    if (!result.ok) {
      return res.status(502).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});
