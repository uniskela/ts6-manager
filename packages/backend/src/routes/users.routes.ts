import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { validatePassword } from '../utils/validate-password.js';
import { actorFromRequest, recordLocalSuccess } from '../audit/index.js';

const VALID_ROLES = ['admin', 'viewer'];

export const userRoutes: Router = Router();

userRoutes.use(requireRole('admin'));

userRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const users = await prisma.user.findMany({
      select: { id: true, username: true, displayName: true, role: true, enabled: true, createdAt: true, lastLoginAt: true },
      orderBy: { id: 'asc' },
    });
    res.json(users);
  } catch (err) { next(err); }
});

userRoutes.post('/', async (req: Request, res: Response, next) => {
  try {
    const { username, password, displayName, role } = req.body;
    if (!username || !password || !displayName) throw new AppError(400, 'Username, password, and display name required');

    const pwError = validatePassword(password);
    if (pwError) throw new AppError(400, pwError);

    const assignedRole = role || 'viewer';
    if (!VALID_ROLES.includes(assignedRole)) throw new AppError(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);

    const prisma = req.app.locals.prisma;
    const passwordHash = await bcrypt.hash(password, 12);
    // Never audit password / passwordHash
    const { result: user } = await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'user.create',
        target: { type: 'user' },
      },
      async (tx) => tx.user.create({
        data: { username, passwordHash, displayName, role: assignedRole },
      }),
      { resolveTargetId: (created) => created.id },
    );

    res.status(201).json({ id: user.id, username: user.username });
  } catch (err) { next(err); }
});

userRoutes.put('/:userId', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.userId));
    const data: any = {};

    if (req.body.displayName !== undefined) data.displayName = req.body.displayName;
    if (req.body.role !== undefined) {
      if (!VALID_ROLES.includes(req.body.role)) throw new AppError(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
      data.role = req.body.role;
    }
    if (req.body.enabled !== undefined) data.enabled = req.body.enabled;
    if (req.body.password) {
      const pwError = validatePassword(req.body.password);
      if (pwError) throw new AppError(400, pwError);
      data.passwordHash = await bcrypt.hash(req.body.password, 12);
    }

    await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'user.update',
        target: { type: 'user', id },
      },
      async (tx) => {
        await tx.user.update({ where: { id }, data });
      },
    );
    res.status(204).send();
  } catch (err) { next(err); }
});

userRoutes.delete('/:userId', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.userId));
    if (id === req.user!.id) throw new AppError(400, 'Cannot delete your own account');
    await recordLocalSuccess(
      prisma,
      {
        actor: actorFromRequest(req.user),
        action: 'user.delete',
        target: { type: 'user', id },
      },
      async (tx) => {
        await tx.user.delete({ where: { id } });
      },
    );
    res.status(204).send();
  } catch (err) { next(err); }
});
