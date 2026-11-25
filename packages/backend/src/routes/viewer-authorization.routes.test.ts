import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '../../generated/prisma/index.js';
import { config } from '../config.js';
import { listen } from './test-support/listen-loopback.js';

const admin = 1;
const assignedViewer = 2;
const unassignedViewer = 3;
const assignedServer = 1;
const otherServer = 2;
const serverPath = (id: number) => `/api/servers/${id}`;
const virtualPath = (id: number) => `${serverPath(id)}/vs/1`;

let directory: string | undefined;
let prisma: PrismaClient | undefined;
let listener: Awaited<ReturnType<typeof listen>> | undefined;
const upstreamCalls: string[] = [];
const previousMusicDir = process.env.MUSIC_DIR;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ts6-viewer-auth-'));
  process.env.MUSIC_DIR = join(directory, 'music');
  const { createApp } = await import('../app.js');

  const databaseUrl = `file:${join(directory, 'test.db')}`;
  execFileSync(
    process.execPath,
    [fileURLToPath(import.meta.resolve('prisma/build/index.js')), 'db', 'push', '--skip-generate'],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    },
  );

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.tsServerConfig.createMany({
    data: [assignedServer, otherServer].map(id => ({
      id,
      name: `Server ${id}`,
      host: `server-${id}.invalid`,
      apiKey: 'fixture-api-key',
      sshUsername: 'fixture-ssh-user',
      sshPassword: 'fixture-ssh-password',
      metricsEnabled: true,
      metricsHost: 'metrics.invalid',
    })),
  });
  await prisma.user.createMany({
    data: [admin, assignedViewer, unassignedViewer].map(id => ({
      id,
      username: `user-${id}`,
      displayName: `User ${id}`,
      role: id === admin ? 'admin' : 'viewer',
      passwordHash: 'unused-fixture',
    })),
  });
  await prisma.userServerAccess.create({ data: { userId: assignedViewer, serverConfigId: assignedServer } });

  const app = createApp();
  app.locals.prisma = prisma;
  app.locals.connectionPool = {
    getClient: (id: number) => {
      upstreamCalls.push(`WebQuery connection ${id}`);
      return {
        execute: async (_sid: number, command: string) => {
          upstreamCalls.push(command);
          return [{ command }];
        },
      };
    },
  };
  app.locals.botEngine = {
    getEventBridge: () => {
      upstreamCalls.push('SSH bridge');
      return {
        getClientCacheGeneration: () => 0,
        executeCommand: async (_id: number, _sid: number, command: string) => {
          upstreamCalls.push(command);
          return 'name=example.txt size=7 datetime=1700000000 type=0';
        },
      };
    },
  };
  listener = await listen(app);
});

after(async () => {
  await listener?.close();
  await prisma?.$disconnect();
  if (previousMusicDir === undefined) delete process.env.MUSIC_DIR;
  else process.env.MUSIC_DIR = previousMusicDir;
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function get(path: string, userId?: number) {
  assert.ok(listener);
  const headers = userId === undefined ? {} : {
    // The HTTP auth middleware must use the persisted role, even with a stale admin claim.
    Authorization: `Bearer ${jwt.sign({ id: userId, role: 'admin' }, config.jwtSecret, { expiresIn: '1m' })}`,
  };
  const response = await fetch(`${listener.base}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

test('server list scopes viewers to their assignments and keeps administrator metadata', async () => {
  const adminResponse = await get('/api/servers', admin);
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(adminResponse.body.map(({ id }: { id: number }) => id), [assignedServer, otherServer]);

  const viewerResponse = await get('/api/servers', assignedViewer);
  assert.equal(viewerResponse.status, 200);
  assert.deepEqual(viewerResponse.body.map(({ id }: { id: number }) => id), [assignedServer]);

  const emptyResponse = await get('/api/servers', unassignedViewer);
  assert.deepEqual(emptyResponse, { status: 200, body: [] });

  const [adminRow] = adminResponse.body;
  const [viewerRow] = viewerResponse.body;
  assert.equal(adminRow.metricsHost, 'metrics.invalid');
  assert.equal(viewerRow.host, 'server-1.invalid');
  assert.equal(viewerRow.hasSshCredentials, true);
  for (const field of ['metricsEnabled', 'metricsHost', 'metricsPort']) {
    assert.ok(!(field in viewerRow), field);
  }
  for (const field of ['apiKey', 'sshPassword', 'sshUsername']) {
    assert.ok(!(field in adminRow), field);
    assert.ok(!(field in viewerRow), field);
  }
  assert.equal((await get('/api/servers')).status, 401);
});

test('direct server details use the same access policy as the list', async () => {
  const adminResponse = await get(serverPath(otherServer), admin);
  assert.equal(adminResponse.status, 200);
  assert.equal(adminResponse.body.id, otherServer);
  assert.equal(adminResponse.body.metricsHost, 'metrics.invalid');

  const viewerResponse = await get(serverPath(assignedServer), assignedViewer);
  assert.equal(viewerResponse.status, 200);
  assert.equal(viewerResponse.body.id, assignedServer);
  assert.equal(viewerResponse.body.host, 'server-1.invalid');
  assert.ok(!('metricsHost' in viewerResponse.body));
  for (const field of ['apiKey', 'sshPassword', 'sshUsername']) {
    assert.ok(!(field in adminResponse.body), field);
    assert.ok(!(field in viewerResponse.body), field);
  }

  const forbidden = await get(serverPath(otherServer), assignedViewer);
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await get(serverPath(999), assignedViewer), forbidden);
  assert.deepEqual(await get(serverPath(assignedServer), unassignedViewer), forbidden);
  assert.equal((await get(serverPath(999), admin)).status, 404);
  assert.equal((await get(serverPath(assignedServer))).status, 401);
});

test('administrative reads deny viewers before acquiring a WebQuery or SSH client', async (t) => {
  for (const suffix of ['/instance', '/instance/host', '/instance/version']) {
    await t.test(suffix, () => checkAdminRead(serverPath, suffix));
  }
  for (const suffix of [
    '/complaints', '/messages', '/messages/1', '/permissions', '/permissions/find',
    '/permissions/overview/1', '/files/1', '/files/summary?cids=1',
    '/channels/1/permissions', '/clients/1/permissions', '/clients/1/groups',
    '/server-groups', '/server-groups/1/permissions', '/server-groups/1/members',
    '/channel-groups', '/channel-groups/1/permissions', '/channel-groups/1/clients',
    '/bans', '/tokens', '/clients/database', '/clients/database/1',
  ]) {
    await t.test(suffix, () => checkAdminRead(virtualPath, suffix));
  }
});

async function checkAdminRead(path: (id: number) => string, suffix: string) {
  const start = upstreamCalls.length;
  assert.equal((await get(path(assignedServer) + suffix, assignedViewer)).status, 403);
  assert.equal((await get(path(assignedServer) + suffix, unassignedViewer)).status, 403);
  assert.equal((await get(path(otherServer) + suffix, assignedViewer)).status, 403);
  assert.deepEqual(upstreamCalls.slice(start), []);
  assert.equal((await get(path(assignedServer) + suffix, admin)).status, 200);
  assert.ok(upstreamCalls.length > start, 'the authorized read reaches its backend');
}

test('assigned viewers and administrators can still browse channels and connected clients', async () => {
  for (const [suffix, command] of [
    ['/channels', 'channellist'],
    ['/channels/1', 'channelinfo'],
    ['/clients', 'clientlist'],
    ['/clients/1', 'clientinfo'],
  ]) {
    const start = upstreamCalls.length;
    assert.equal((await get(virtualPath(otherServer) + suffix, assignedViewer)).status, 403);
    assert.equal((await get(virtualPath(assignedServer) + suffix, unassignedViewer)).status, 403);
    assert.deepEqual(upstreamCalls.slice(start), [], suffix);
    assert.deepEqual(await get(virtualPath(assignedServer) + suffix, assignedViewer), {
      status: 200,
      body: [{ command }],
    });
    assert.deepEqual(await get(virtualPath(otherServer) + suffix, admin), {
      status: 200,
      body: [{ command }],
    });
  }
});
