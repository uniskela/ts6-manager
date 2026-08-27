import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { isReservedChatCommandName, normalizeChatCommandName } from '../voice/chat-commands.js';

export const chatCommandRoutes: Router = Router({ mergeParams: true });

chatCommandRoutes.use(requireRole('admin'));

const MAX_RESPONSE_LEN = 900;
const MAX_DESCRIPTION_LEN = 120;

function validateCommandPayload(body: {
  name?: unknown;
  response?: unknown;
  description?: unknown;
  enabled?: unknown;
}): {
  name: string;
  response: string;
  description: string | null;
  enabled: boolean;
} {
  const name = normalizeChatCommandName(typeof body.name === 'string' ? body.name : '');
  if (!name) {
    throw new AppError(400, 'name is required (letters, numbers, hyphens, underscores; no "!")');
  }
  if (isReservedChatCommandName(name)) {
    throw new AppError(400, `"!${name}" is a built-in command and cannot be overridden`);
  }

  const response = typeof body.response === 'string' ? body.response.trim() : '';
  if (!response) throw new AppError(400, 'response is required');
  if (response.length > MAX_RESPONSE_LEN) {
    throw new AppError(400, `response must be at most ${MAX_RESPONSE_LEN} characters`);
  }

  let description: string | null = null;
  if (typeof body.description === 'string' && body.description.trim()) {
    description = body.description.trim().slice(0, MAX_DESCRIPTION_LEN);
  }

  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
  return { name, response, description, enabled };
}

// GET / — List custom chat commands for this server
chatCommandRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);
    const commands = await prisma.chatCommand.findMany({
      where: { serverConfigId: configId },
      orderBy: { name: 'asc' },
    });
    res.json(commands);
  } catch (err) {
    next(err);
  }
});

// POST / — Create custom chat command
chatCommandRoutes.post('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);
    const data = validateCommandPayload(req.body);

    const existing = await prisma.chatCommand.findUnique({
      where: { serverConfigId_name: { serverConfigId: configId, name: data.name } },
    });
    if (existing) throw new AppError(409, `Command "!${data.name}" already exists`);

    const command = await prisma.chatCommand.create({
      data: {
        serverConfigId: configId,
        name: data.name,
        response: data.response,
        description: data.description,
        enabled: data.enabled,
      },
    });
    res.status(201).json(command);
  } catch (err) {
    next(err);
  }
});

// PUT /:id — Update custom chat command
chatCommandRoutes.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);
    const id = parseInt(req.params.id as string);
    const existing = await prisma.chatCommand.findFirst({
      where: { id, serverConfigId: configId },
    });
    if (!existing) throw new AppError(404, 'Chat command not found');

    const data = validateCommandPayload({
      name: req.body.name ?? existing.name,
      response: req.body.response ?? existing.response,
      description:
        req.body.description === undefined ? existing.description : req.body.description,
      enabled: req.body.enabled === undefined ? existing.enabled : req.body.enabled,
    });

    if (data.name !== existing.name) {
      const clash = await prisma.chatCommand.findUnique({
        where: { serverConfigId_name: { serverConfigId: configId, name: data.name } },
      });
      if (clash) throw new AppError(409, `Command "!${data.name}" already exists`);
    }

    const command = await prisma.chatCommand.update({
      where: { id },
      data: {
        name: data.name,
        response: data.response,
        description: data.description,
        enabled: data.enabled,
      },
    });
    res.json(command);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — Remove custom chat command
chatCommandRoutes.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);
    const id = parseInt(req.params.id as string);
    const existing = await prisma.chatCommand.findFirst({
      where: { id, serverConfigId: configId },
    });
    if (!existing) throw new AppError(404, 'Chat command not found');
    await prisma.chatCommand.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
