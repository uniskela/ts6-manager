/** Disposable real-route fixture; no production database or network services. */
import express, { type Express, type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { authRoutes } from '../auth.routes.js';
import { userRoutes } from '../users.routes.js';
import { authMiddleware } from '../../middleware/auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { listen } from './listen-loopback.js';

export type SqliteAuthPool = 'default' | number;

/**
 * Explicit pool size for the fixture URL; `default` keeps Prisma's own pool.
 * This worktree does NOT change the production pool configuration — the
 * default is what production uses here.
 */
export function poolDatasourceUrl(databaseUrl: string, pool: SqliteAuthPool): string {
  if (pool === 'default') return databaseUrl;
  const query = databaseUrl.indexOf('?');
  const params = new URLSearchParams(query < 0 ? '' : databaseUrl.slice(query + 1));
  params.set('connection_limit', String(pool));
  return `${databaseUrl.slice(0, query < 0 ? databaseUrl.length : query)}?${params.toString()}`;
}

export async function openSqliteAuthApp(pool: SqliteAuthPool): Promise<{
  app: Express; prisma: PrismaClient; databaseUrl: string; base: string;
  reset: () => Promise<void>; engine: string[]; errors: string[]; close: () => Promise<void>;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-auth-pool-'));
  const databaseUrl = `file:${join(directory, 'test.db')}`;
  execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('prisma/build/index.js')), 'db', 'push', '--skip-generate'], {
    cwd: join(import.meta.dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
  });
  const prisma = new PrismaClient({
    datasourceUrl: poolDatasourceUrl(databaseUrl, pool),
    log: [{ emit: 'event', level: 'info' }],
  });
  const engine: string[] = [];
  const errors: string[] = [];
  prisma.$on('info', (event) => engine.push(event.message));
  await prisma.$connect();
  const passwordHash = await bcrypt.hash('test-password', 12);
  let presented: string[] = [];
  let rotateCount = 0;
  let latest: string | null = null;
  const reset = async () => {
    await prisma.adminAuditEvent.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
    await prisma.user.createMany({ data: [
      { id: 1, username: 'admin', displayName: 'Alice', role: 'admin', passwordHash },
      { id: 2, username: 'operator', displayName: 'Operator', role: 'admin', passwordHash },
      { id: 3, username: 'other', displayName: 'Other', role: 'viewer', passwordHash },
    ] });
    presented = []; rotateCount = 0; latest = null; errors.length = 0;
  };
  await reset();
  const app = express();
  app.use(express.json());
  app.locals.prisma = prisma;
  app.post('/__test/reset', async (_req, res, next) => {
    try { await reset(); res.json({ ok: true }); } catch (err) { next(err); }
  });
  app.get('/__test/refresh-state', async (_req, res, next) => {
    try {
      const row = latest ? await prisma.refreshToken.findUnique({ where: { token: latest } }) : null;
      const revoked = latest !== null && row === null;
      res.json({ rotateCount, presented, live: row?.token ?? null, revoked,
        replayRevokes: revoked && new Set(presented).size < presented.length ? 1 : 0,
        consumedCount: await prisma.refreshToken.count({ where: { replacedBy: { not: null } } }), engine, errors });
    } catch (err) { next(err); }
  });
  // Bounded request budget for the fixture's API routes. The fixture is a
  // disposable test double, but it still exposes authentication and
  // administrative handlers, so it applies a limit rather than leaving them
  // unbounded. It uses the same rate limiter as the production routes, with a
  // budget far above what the coordination tests use.
  const limit = rateLimit({
    windowMs: 60_000,
    max: 20_000,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/auth', limit, (req, res, next) => {
    if (req.path === '/refresh') presented.push(req.body.refreshToken);
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200 && body.refreshToken) {
        latest = body.refreshToken;
        if (req.path === '/refresh') rotateCount++;
      }
      return json(body);
    };
    next();
  }, authRoutes);
  // Diagnostic only (agent investigation): classify each presented refresh token
  // as fresh / already-consumed / unknown, so a browser "extra POST" can be
  // attributed to concurrent reuse vs. sequential use of a newer valid token.
  app.get('/__test/refresh-diagnostics', async (_req, res, next) => {
    try {
      const rows = await prisma.refreshToken.findMany({
        select: { token: true, replacedBy: true, family: true, id: true },
      });
      const byToken = new Map(rows.map((r) => [r.token, r]));
      const events = presented.map((token, index) => {
        const row = byToken.get(token);
        return {
          index,
          known: Boolean(row),
          // replacedBy set means this exact token was already consumed by an
          // earlier rotation -> presenting it again is a replay.
          consumed: Boolean(row?.replacedBy),
          family: row?.family ?? null,
          // Was this token the successor minted by an earlier presented token?
          successorOfPresented: presented.slice(0, index).some((t) => byToken.get(t)?.replacedBy === token),
          live: row ? !row.replacedBy : false,
        };
      });
      res.json({ events, rotateCount, presentedCount: presented.length });
    } catch (err) { next(err); }
  });
  app.use('/api/users', limit, authMiddleware, (req, res, next) => {
    userRoutes(req, res, next);
  });
  const captureError: ErrorRequestHandler = (err, _req, _res, next) => {
    if (typeof err?.code === 'string') errors.push(err.code);
    next(err);
  };
  app.use(captureError);
  app.use(errorHandler);
  const { base, close } = await listen(app);
  return { app, prisma, databaseUrl, base, reset, engine, errors, close: async () => {
    await close(); await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true });
  } };
}
