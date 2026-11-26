/**
 * Disposable SQLite + auth-routes harness for P1 real-DB suites.
 * Each call creates an isolated temp database and loopback listener.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { createAuthApp, postAuthRefresh } from './mount-auth-app.js';
import { listen } from './listen-loopback.js';

export type AuthSqliteHarness = {
  prisma: PrismaClient;
  baseUrl: () => Promise<string>;
  seedAlice: () => Promise<void>;
  adminDisable: () => Promise<void>;
  adminResetPassword: (newPassword: string) => Promise<void>;
  postRefresh: (refreshToken: string) => Promise<Response>;
  close: () => Promise<void>;
};

export async function openAuthSqliteHarness(tempPrefix: string): Promise<AuthSqliteHarness> {
  const directory = mkdtempSync(join(tmpdir(), tempPrefix));
  const databaseUrl = `file:${join(directory, 'test.db')}`;
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  execFileSync(
    process.execPath,
    [fileURLToPath(import.meta.resolve('prisma/build/index.js')), 'db', 'push', '--skip-generate', '--accept-data-loss'],
    {
      cwd: join(import.meta.dirname, '../../..'),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    },
  );

  const { base, close: closeListen } = await listen(createAuthApp(prisma));

  return {
    prisma,
    baseUrl: async () => base,
    seedAlice: async () => {
      await prisma.refreshToken.deleteMany();
      await prisma.user.deleteMany();
      const passwordHash = await bcrypt.hash('AlicePass1', 4);
      await prisma.user.create({
        data: {
          id: 1,
          username: 'alice',
          displayName: 'Alice',
          role: 'admin',
          passwordHash,
          enabled: true,
        },
      });
    },
    adminDisable: async () => {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: 1 }, data: { enabled: false } });
        await tx.refreshToken.deleteMany({ where: { userId: 1 } });
      });
    },
    adminResetPassword: async (newPassword: string) => {
      const passwordHash = await bcrypt.hash(newPassword, 4);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: 1 }, data: { passwordHash } });
        await tx.refreshToken.deleteMany({ where: { userId: 1 } });
      });
    },
    postRefresh: (refreshToken: string) => postAuthRefresh(base, refreshToken),
    close: async () => {
      await closeListen();
      await prisma.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
