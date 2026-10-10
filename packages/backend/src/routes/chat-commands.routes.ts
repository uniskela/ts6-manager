import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import {
  loadMediaCommandPermissions,
  parseMediaCommandPermissions,
  saveMediaCommandPermissions,
} from '../voice/media-command-permissions.js';
import {
  CHAT_COMMAND_PRESETS,
  isReservedChatCommandName,
  normalizeChatCommandName,
} from '../voice/chat-commands.js';

export const chatCommandRoutes: Router = Router({ mergeParams: true });

chatCommandRoutes.use(requireRole('admin'));

const MAX_RESPONSE_LEN = 900;
const MAX_DESCRIPTION_LEN = 120;

function permissionScope(req: Request): { configId: number; sid: number } {
  const configId = Number(req.params.configId);
  const sid = Number(req.params.sid);
  if (!Number.isSafeInteger(configId) || configId <= 0 || !Number.isSafeInteger(sid) || sid <= 0) {
    throw new AppError(400, 'A valid server connection and virtual server are required');
  }
  return { configId, sid };
}

// Policy scope includes the virtual server: TS server group IDs are local to each SID.
chatCommandRoutes.get('/permissions/:sid', async (req: Request, res: Response, next) => {
  try {
    const { configId, sid } = permissionScope(req);
    res.json(await loadMediaCommandPermissions(req.app.locals.prisma, configId, sid));
  } catch (err) { next(err); }
});

chatCommandRoutes.put('/permissions/:sid', async (req: Request, res: Response, next) => {
  try {
    const { configId, sid } = permissionScope(req);
    const policy = parseMediaCommandPermissions(req.body);
    if (!policy) throw new AppError(400, 'Supply playback, queue and video access: everyone or server_groups with positive serverGroupIds');
    res.json(await saveMediaCommandPermissions(req.app.locals.prisma, configId, sid, policy));
  } catch (err) { next(err); }
});

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

// GET /presets — Recommended canned-reply templates (not yet bound to this server)
chatCommandRoutes.get('/presets', (_req: Request, res: Response) => {
  res.json(CHAT_COMMAND_PRESETS);
});

// POST /seed-presets — Create missing recommended presets (disabled until edited/enabled)
chatCommandRoutes.post('/seed-presets', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const configId = parseInt(req.params.configId as string);

    const names = CHAT_COMMAND_PRESETS.map((p) => p.name);
    const existing = await prisma.chatCommand.findMany({
      where: { serverConfigId: configId, name: { in: names } },
      select: { name: true },
    });
    const existingNames = new Set(existing.map((c: { name: string }) => c.name));

    const created = [];
    for (const preset of CHAT_COMMAND_PRESETS) {
      if (existingNames.has(preset.name)) continue;
      if (isReservedChatCommandName(preset.name)) continue;
      const command = await prisma.chatCommand.create({
        data: {
          serverConfigId: configId,
          name: preset.name,
          response: preset.response.slice(0, MAX_RESPONSE_LEN),
          description: preset.description.slice(0, MAX_DESCRIPTION_LEN),
          enabled: false,
        },
      });
      created.push(command);
    }

    const commands = await prisma.chatCommand.findMany({
      where: { serverConfigId: configId },
      orderBy: { name: 'asc' },
    });
    res.json({ created: created.length, createdNames: created.map((c) => c.name), commands });
  } catch (err) {
    next(err);
  }
});

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
