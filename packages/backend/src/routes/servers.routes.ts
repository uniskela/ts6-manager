import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { WebQueryClient, createWebQueryClient } from '../ts-client/webquery-client.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { testSshConnection } from '../utils/ssh-test.js';
import {
  assertResolvableTsServerHost,
  sanitizeTsServerHost,
  validateTsServerPort,
} from '../utils/validate-ts-host.js';

export const serverRoutes: Router = Router();

// List all configured TS server connections
serverRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const servers = await prisma.tsServerConfig.findMany({
      select: {
        id: true, name: true, host: true, webqueryPort: true,
        useHttps: true, sshPort: true, enabled: true,
        createdAt: true, sshUsername: true, sshPassword: true,
      },
      orderBy: { id: 'asc' },
    });

    res.json(servers.map((s: any) => ({
      ...s,
      hasSshCredentials: !!s.sshUsername && !!s.sshPassword,
      sshUsername: undefined,
      sshPassword: undefined,
    })));
  } catch (err) { next(err); }
});

// Add new TS server connection
serverRoutes.post('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const { name, host, webqueryPort, apiKey, useHttps, sshPort, sshUsername, sshPassword } = req.body;
    if (!name || !host || !apiKey) throw new AppError(400, 'Name, host, and API key are required');

    const safeHost = sanitizeTsServerHost(host);
    const safeWebqueryPort = validateTsServerPort(webqueryPort, 10080);
    const safeSshPort = validateTsServerPort(sshPort, 10022);

    const prisma = req.app.locals.prisma;
    // H8: Encrypt sensitive fields at rest
    const server = await prisma.tsServerConfig.create({
      data: {
        name,
        host: safeHost,
        webqueryPort: safeWebqueryPort,
        apiKey: encrypt(apiKey),
        useHttps: useHttps || false,
        sshPort: safeSshPort,
        sshUsername: sshUsername || null,
        sshPassword: sshPassword ? encrypt(sshPassword) : null,
      },
    });

    // Add to connection pool (use plaintext key for connection)
    const pool: ConnectionPool = req.app.locals.connectionPool;
    pool.addClient(server.id, server.host, server.webqueryPort, apiKey, server.useHttps);

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

    res.json({
      id: server.id, name: server.name, host: server.host,
      webqueryPort: server.webqueryPort, useHttps: server.useHttps,
      sshPort: server.sshPort, hasSshCredentials: !!server.sshUsername && !!server.sshPassword,
      enabled: server.enabled, createdAt: server.createdAt,
    });
  } catch (err) { next(err); }
});

// Update server connection
serverRoutes.put('/:configId', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.configId));
    const data: any = {};

    const fields = ['name', 'host', 'webqueryPort', 'apiKey', 'useHttps', 'sshPort', 'sshUsername', 'sshPassword', 'enabled'];
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
        // H8: Encrypt sensitive fields
        if (field === 'apiKey' || field === 'sshPassword') {
          data[field] = encrypt(req.body[field]);
        } else {
          data[field] = req.body[field];
        }
      }
    }

    const server = await prisma.tsServerConfig.update({ where: { id }, data });

    // Refresh WebQuery connection pool (destroy old sockets first)
    const pool: ConnectionPool = req.app.locals.connectionPool;
    await pool.refreshClient(id);

    // Force EventBridge SSH reconnect so updated SSH credentials take effect
    const botEngine = req.app.locals.botEngine;
    if (botEngine?.getEventBridge) {
      await botEngine.getEventBridge().reconnectConfig(id);
    }

    res.json({ id: server.id, name: server.name });
  } catch (err) { next(err); }
});

// Delete server connection
serverRoutes.delete('/:configId', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.configId));
    await prisma.tsServerConfig.delete({ where: { id } });

    const pool: ConnectionPool = req.app.locals.connectionPool;
    pool.removeClient(id);

    res.status(204).send();
  } catch (err) { next(err); }
});

// Test WebQuery with draft credentials (not persisted)
serverRoutes.post('/test-webquery', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const { host, webqueryPort, apiKey, useHttps } = req.body;
    if (!host || !apiKey) throw new AppError(400, 'Host and API key are required');

    const safeHost = await assertResolvableTsServerHost(host);
    const safePort = validateTsServerPort(webqueryPort, 10080);

    const client = createWebQueryClient(safeHost, safePort, apiKey, useHttps || false);
    const result = await client.testConnection();
    client.destroy();

    if (!result.ok) {
      return res.status(502).json({ success: false, error: result.error });
    }
    res.json({ success: true, version: result.version });
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

// Test connection
serverRoutes.post('/:configId/test', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const server = await prisma.tsServerConfig.findUnique({
      where: { id: parseInt(String(req.params.configId)) },
    });
    if (!server) throw new AppError(404, 'Server config not found');

    const client = createWebQueryClient(server.host, server.webqueryPort, decrypt(server.apiKey), server.useHttps);
    const result = await client.testConnection();
    client.destroy(); // Close the temporary TCP connection immediately

    if (!result.ok) {
      return res.status(502).json({ success: false, error: result.error });
    }
    res.json({ success: true, version: result.version });
  } catch (err) { next(err); }
});

// Test SSH for an existing connection
serverRoutes.post('/:configId/test-ssh', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const server = await prisma.tsServerConfig.findUnique({
      where: { id: parseInt(String(req.params.configId)) },
    });
    if (!server) throw new AppError(404, 'Server config not found');
    if (!server.sshUsername || !server.sshPassword) {
      throw new AppError(400, 'SSH credentials not configured');
    }

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
