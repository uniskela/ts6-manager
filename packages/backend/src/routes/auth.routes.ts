import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError } from '../middleware/error-handler.js';
import { validatePassword } from '../utils/validate-password.js';

export const authRoutes: Router = Router();

/** Optional test-only seams for deterministic concurrency (never set in production). */
export type AuthTestHooks = {
  afterPasswordVerified?: () => Promise<void>;
  beforeRefreshRotate?: () => Promise<void>;
};

const meRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Revoke one refresh-token family for a user. Null family = legacy rows only. */
async function revokeRefreshFamily(
  tx: {
    refreshToken: {
      deleteMany: (args: {
        where: { userId: number; family: string | null };
      }) => Promise<{ count: number }>;
    };
  },
  userId: number,
  family: string | null,
): Promise<void> {
  await tx.refreshToken.deleteMany({ where: { userId, family } });
}

authRoutes.post('/login', async (req: Request, res: Response, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new AppError(400, 'Username and password required');

    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !user.enabled) throw new AppError(401, 'Invalid credentials');

    const passwordHashAtAuth = user.passwordHash;
    const valid = await bcrypt.compare(password, passwordHashAtAuth);
    if (!valid) throw new AppError(401, 'Invalid credentials');

    const hooks = req.app.locals.authTestHooks as AuthTestHooks | undefined;
    if (hooks?.afterPasswordVerified) await hooks.afterPasswordVerified();

    // Re-check enabled + password hash inside the mint transaction so an admin
    // reset/disable during bcrypt cannot leave a post-revoke refresh token.
    const minted = await prisma.$transaction(async (tx: typeof prisma) => {
      const fresh = await tx.user.findUnique({ where: { id: user.id } });
      if (!fresh || !fresh.enabled || fresh.passwordHash !== passwordHashAtAuth) {
        throw new AppError(401, 'Invalid credentials');
      }

      const payload = { id: fresh.id, username: fresh.username, role: fresh.role };
      const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtAccessExpiry } as jwt.SignOptions);
      const refreshToken = crypto.randomBytes(64).toString('hex');
      const family = nanoid();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      await tx.refreshToken.create({
        data: { token: refreshToken, userId: fresh.id, expiresAt, family },
      });
      await tx.user.update({
        where: { id: fresh.id },
        data: { lastLoginAt: new Date() },
      });

      return {
        accessToken,
        refreshToken,
        user: {
          id: fresh.id,
          username: fresh.username,
          displayName: fresh.displayName,
          role: fresh.role,
        },
      };
    });

    res.json(minted);
  } catch (err) { next(err); }
});

authRoutes.post('/refresh', async (req: Request, res: Response, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError(400, 'Refresh token required');

    const prisma = req.app.locals.prisma;

    // Bounded retention: drop expired live and consumed rows (reuse window ends at expiresAt).
    await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    // Replay must revoke in a committed write — throwing inside the rotate transaction
    // would roll the family delete back with the AppError.
    const existing = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });
    if (!existing) {
      throw new AppError(401, 'Invalid refresh token');
    }
    if (existing.replacedBy) {
      console.warn(
        `[SECURITY] Refresh token reuse detected for user ${existing.userId} family=${existing.family ?? 'null'}. Revoking family.`,
      );
      await revokeRefreshFamily(prisma, existing.userId, existing.family);
      throw new AppError(401, 'Invalid refresh token');
    }
    if (existing.expiresAt < new Date() || !existing.user.enabled) {
      await prisma.refreshToken.delete({ where: { id: existing.id } });
      throw new AppError(401, 'Invalid refresh token');
    }

    const hooks = req.app.locals.authTestHooks as AuthTestHooks | undefined;
    if (hooks?.beforeRefreshRotate) await hooks.beforeRefreshRotate();

    const rotated = await prisma.$transaction(async (tx: typeof prisma) => {
      const stored = await tx.refreshToken.findUnique({
        where: { token: refreshToken },
        include: { user: true },
      });

      if (!stored || stored.replacedBy || stored.expiresAt < new Date() || !stored.user.enabled) {
        throw new AppError(401, 'Invalid refresh token');
      }

      const newRefreshToken = crypto.randomBytes(64).toString('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      // Legacy null-family rows get a stable family on first rotate after this fix.
      const family = stored.family ?? nanoid();

      // Compare-and-swap: only one concurrent refresh may consume this row.
      const marked = await tx.refreshToken.updateMany({
        where: { id: stored.id, replacedBy: null },
        data: { replacedBy: newRefreshToken, family },
      });
      if (marked.count === 0) {
        // Lost the race to another refresh of the same live token — do not revoke the winner.
        throw new AppError(401, 'Invalid refresh token');
      }

      await tx.refreshToken.create({
        data: { token: newRefreshToken, userId: stored.userId, expiresAt, family },
      });

      const payload = { id: stored.user.id, username: stored.user.username, role: stored.user.role };
      const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtAccessExpiry } as jwt.SignOptions);
      return { accessToken, refreshToken: newRefreshToken };
    });

    res.json(rotated);
  } catch (err) { next(err); }
});

authRoutes.post('/logout', async (req: Request, res: Response, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const prisma = req.app.locals.prisma;
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

authRoutes.get('/me', meRateLimiter, authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    });
  } catch (err) { next(err); }
});

authRoutes.put('/password', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) throw new AppError(400, 'Both passwords required');

    const pwError = validatePassword(newPassword);
    if (pwError) throw new AppError(400, pwError);

    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new AppError(401, 'Current password is incorrect');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Revoke all refresh tokens on password change
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    res.status(204).send();
  } catch (err) { next(err); }
});
