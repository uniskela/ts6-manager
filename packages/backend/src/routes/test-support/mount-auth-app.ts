/**
 * Test-only: mount auth routes on an isolated loopback listener.
 * Each call gets its own Express app — no shared mutable request state.
 */
import express, { type Express } from 'express';
import { authRoutes } from '../auth.routes.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { listen } from './listen-loopback.js';

export function createAuthApp(prisma: unknown): Express {
  const app = express();
  app.use(express.json());
  app.locals.prisma = prisma;
  app.use('/api/auth', authRoutes);
  app.use(errorHandler);
  return app;
}

export async function withAuthApp(
  prisma: unknown,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const { base, close } = await listen(createAuthApp(prisma));
  try {
    await run(base);
  } finally {
    await close();
  }
}

export function postAuthRefresh(base: string, refreshToken: string): Promise<Response> {
  return fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
}
