import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireServerAccess } from '../middleware/server-access.js';
import { musicLibraryRoutes } from './music-library.routes.js';
import { downloadJobs } from '../voice/audio/download-progress.js';

test('download polling requires authentication, admin RBAC, matching server and requesting user', async () => {
  const app = express();
  app.locals.prisma = {
    user: { findUnique: async ({ where }: any) => ({ enabled: true, role: where.id === 3 ? 'viewer' : 'admin' }) },
    userServerAccess: { findUnique: async ({ where }: any) => where.userId_serverConfigId.serverConfigId === 1 ? {} : null },
  };
  app.use(authMiddleware);
  app.use('/servers/:configId/music-library', requireServerAccess(), musicLibraryRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ error: 'Unavailable' }));
  const job = downloadJobs.create(1, 1, 1);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const get = (serverId: number, userId?: number) => fetch(`${base}/servers/${serverId}/music-library/youtube/download-jobs/${job.id}`, {
    headers: userId ? { Authorization: `Bearer ${jwt.sign({ id: userId, role: 'admin' }, config.jwtSecret, { algorithm: 'HS256' })}` } : {},
  });
  try {
    assert.equal((await get(1)).status, 401);
    assert.equal((await get(1, 3)).status, 403); // assigned viewer still fails admin RBAC
    assert.equal((await get(2, 3)).status, 403); // unassigned server fails server access
    assert.equal((await get(2, 1)).status, 404);
    assert.equal((await get(1, 2)).status, 404);
    assert.equal((await get(1, 1)).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
