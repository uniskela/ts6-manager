import { Router, json, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireRole } from '../middleware/rbac.js';
import { actorFromRequest, runRemoteAudited } from '../audit/index.js';
import { ListenerRemoteError, type Binding as ListenerRemoteBinding, type ListenerRemoteService } from '../voice/listener-remote.js';
import { listHumanMediaListeners, resolveMediaIdentity } from '../voice/media-listeners.js';
import { authorizeMediaCommand, loadMediaCommandPermissions } from '../voice/media-command-permissions.js';
import { defaultMediaUrlDeps, runMediaUrlPipeline, type MediaUrlPipelineDeps } from '../voice/media-url-pipeline.js';
import { validateUrl } from '../utils/url-validator.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';
import type { EventBridge } from '../bot-engine/event-bridge.js';
import type { QueueItem } from '../voice/playlist/queue.js';

export const listenerRemoteRoutes: Router = Router();
export const listenerRemoteAdminRoutes: Router = Router();
const resolvingBots = new WeakMap<ListenerRemoteService, Set<number>>();

function service(req: Request): ListenerRemoteService {
  const value = req.app.locals.listenerRemote;
  if (!value) throw new ListenerRemoteError(503, 'unavailable', 'Listener remote is unavailable.');
  return value;
}

function fail(status: number, code: string, message: string): never {
  throw new ListenerRemoteError(status, code, message);
}

function endpoint(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((err: unknown) => {
      if (err instanceof ListenerRemoteError) {
        if (err.status === 429) res.setHeader('Retry-After', '60');
        res.status(err.status).json({ error: err.message, code: err.code });
      } else {
        // Resolver/Query/database exceptions can contain credentials or pasted URLs.
        res.status(503).json({ error: 'Listener remote is unavailable.', code: 'unavailable' });
      }
    });
  };
}

listenerRemoteRoutes.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    service(req).checkIp(req.ip ?? req.socket.remoteAddress ?? 'unknown', /^\/exchange\/?$/i.test(req.path));
    next();
  } catch (err) {
    if (err instanceof ListenerRemoteError) {
      if (err.status === 429) res.setHeader('Retry-After', '60');
      res.status(err.status).json({ error: err.message, code: err.code });
    } else res.status(503).json({ error: 'Listener remote is unavailable.', code: 'unavailable' });
  }
});
listenerRemoteRoutes.use(json({ limit: '4kb' }));

function bearer(req: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') ?? '');
  if (!match) fail(401, 'invalid_access', 'Listener access is invalid or expired.');
  return match[1];
}

function botFor(req: Request, binding: ListenerRemoteBinding) {
  const manager = req.app.locals.voiceBotManager as VoiceBotManager | undefined;
  const bot = manager?.getBot(binding.botId);
  if (!bot || bot.currentConfig.serverConfigId !== binding.serverConfigId
    || bot.getCurrentChannelId() !== binding.channelId
    || !['connected', 'playing', 'paused'].includes(bot.status)) return null;
  return bot;
}

/** Verify the bound bot's server scope and current human identity, never browser claims. */
async function liveIdentity(req: Request, binding: ListenerRemoteBinding) {
  const bot = botFor(req, binding);
  const bridge = req.app.locals.eventBridge as EventBridge | undefined;
  if (!bot || !bridge) return null;
  const row = await req.app.locals.prisma.musicBot.findUnique({
    where: { id: binding.botId }, select: { serverConfigId: true, virtualServerId: true },
  });
  if (!row || row.serverConfigId !== binding.serverConfigId || row.virtualServerId !== binding.virtualServerId) return null;
  const query = (cmd: string) => bridge.executeCommand(binding.serverConfigId, binding.virtualServerId, cmd);
  const identity = await resolveMediaIdentity(query, binding.clid, binding.uid);
  if (!identity) return null;
  const manager = req.app.locals.voiceBotManager as VoiceBotManager;
  const bots = await manager.getBotsForServer(binding.serverConfigId);
  const excluded = new Set(bots.map(({ bot: peer }) => peer.ts3ClientId));
  const listeners = await listHumanMediaListeners(query, binding.channelId, excluded);
  if (!listeners?.some(peer => peer.clid === binding.clid && peer.uid === binding.uid) || !botFor(req, binding)) return null;
  return identity;
}

async function authenticate(req: Request) {
  return service(req).authenticate(bearer(req), async binding => Boolean(await liveIdentity(req, binding)));
}

async function authorized(req: Request, command: string, args = '') {
  let identity: NonNullable<Awaited<ReturnType<typeof liveIdentity>>> | undefined;
  let policy: Awaited<ReturnType<typeof loadMediaCommandPermissions>> | undefined;
  const binding = await service(req).authenticate(bearer(req), async bound => {
    const current = await liveIdentity(req, bound);
    if (!current) return false;
    identity = current;
    policy = await loadMediaCommandPermissions(req.app.locals.prisma, bound.serverConfigId, bound.virtualServerId);
    return true;
  });
  // authenticate rechecks expiry and revocation after every awaited lookup above.
  if (!identity || !policy) fail(503, 'unavailable', 'Listener remote is unavailable.');
  if (!authorizeMediaCommand(policy, command, identity, args)) {
    fail(403, 'permission_denied', 'You are not allowed to use this command.');
  }
  return { binding, identity, policy, bot: botFor(req, binding)! };
}

function body<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) fail(400, 'invalid_request', 'Invalid listener request.');
  return parsed.data;
}

function track(item: QueueItem | null) {
  return item ? { id: item.id, title: item.title, artist: item.artist ?? null, duration: item.duration ?? null } : null;
}

listenerRemoteRoutes.post('/exchange', endpoint(async (req, res) => {
  const { token } = body(req, z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict());
  const result = await service(req).exchange(token, async binding => Boolean(await liveIdentity(req, binding)));
  res.json({ session: result.session, expiresAt: new Date(result.expiresAt).toISOString(), botId: result.binding.botId });
}));

listenerRemoteRoutes.get('/state', endpoint(async (req, res) => {
  const { binding, bot, policy, identity } = await authorized(req, 'np');
  if (!authorizeMediaCommand(policy, 'queue', identity)) fail(403, 'permission_denied', 'You are not allowed to use this command.');
  const canAdd = authorizeMediaCommand(policy, 'add', identity, 'request');
  res.json({
    bot: { id: binding.botId, name: bot.currentConfig.name, status: bot.status },
    nowPlaying: track(bot.nowPlaying), upNext: bot.queue.upcoming(50).map(item => track(item)),
    upNextCount: bot.queue.upcomingCount,
    permissions: { searchLibrary: true, addToQueue: canAdd, requestUrl: canAdd },
  });
}));

listenerRemoteRoutes.get('/library', endpoint(async (req, res) => {
  const query = z.object({ search: z.string().max(200).default(''), page: z.coerce.number().int().min(1).max(10000).default(1) }).strict().safeParse(req.query);
  if (!query.success) fail(400, 'invalid_request', 'Invalid listener request.');
  const { binding } = await authorized(req, 'queue');
  const { search, page } = query.data;
  const songs = await req.app.locals.prisma.song.findMany({
    where: { serverConfigId: binding.serverConfigId, OR: [{ title: { contains: search } }, { artist: { contains: search } }] },
    select: { id: true, title: true, artist: true, duration: true },
    orderBy: { id: 'asc' }, skip: (page - 1) * 25, take: 25,
  });
  await authenticate(req);
  res.json({ songs, page, pageSize: 25 });
}));

function listenerActor(binding: ListenerRemoteBinding) {
  // Reserved non-user actor; the UID fingerprint supports correlation without retaining identity text.
  return { id: 0, username: `listener:${createHash('sha256').update(binding.uid).digest('hex')}` };
}

async function append(req: Request, binding: ListenerRemoteBinding, resolveItem: () => Promise<QueueItem>, action: 'listener.remote.queue_add' | 'listener.remote.request') {
  await runRemoteAudited(req.app.locals.prisma, {
    actor: listenerActor(binding), action, connectionId: binding.serverConfigId,
    virtualServerId: binding.virtualServerId, target: { type: 'music_bot', id: binding.botId },
  }, async () => {
    await authorized(req, 'add', 'request');
    const item = await resolveItem();
    const { bot } = await authorized(req, 'add', 'request');
    if (bot.queue.length >= 500) fail(429, 'rate_limited', 'The queue is full.');
    bot.queue.add(item);
  });
}

listenerRemoteRoutes.post('/queue', endpoint(async (req, res) => {
  const { songId } = body(req, z.object({ songId: z.number().int().positive().safe() }).strict());
  const binding = await authenticate(req);
  await append(req, binding, async () => {
    const song = await req.app.locals.prisma.song.findFirst({ where: { id: songId, serverConfigId: binding.serverConfigId } });
    if (!song) fail(404, 'not_found', 'Song not found.');
    return {
      id: String(song.id), title: song.title, artist: song.artist ?? undefined,
      duration: song.duration ?? undefined, filePath: song.filePath, source: song.source,
      sourceUrl: song.sourceUrl ?? undefined,
    };
  }, 'listener.remote.queue_add');
  res.json({ ok: true });
}));

listenerRemoteRoutes.post('/requests', endpoint(async (req, res) => {
  const { url } = body(req, z.object({ url: z.string().max(2048).url() }).strict());
  const binding = await authenticate(req);
  await append(req, binding, async () => {
    service(req).checkRequest(bearer(req));
    const parsed = new URL(url);
    if (parsed.username || parsed.password || !(await validateUrl(url)).valid) {
      fail(400, 'invalid_request', 'This media URL is not allowed.');
    }
    const remote = service(req);
    let pending = resolvingBots.get(remote);
    if (!pending) { pending = new Set(); resolvingBots.set(remote, pending); }
    if (pending.has(binding.botId) || pending.size >= 4) fail(429, 'rate_limited', 'A media request is already pending.');
    pending.add(binding.botId);
    try {
      // Use the normal resolver/download path; no admin LAN exception and no playlist background work.
      const deps: MediaUrlPipelineDeps = req.app.locals.mediaUrlPipelineDeps ?? defaultMediaUrlDeps();
      let resolved: QueueItem | undefined;
      await runMediaUrlPipeline(deps, {
        play: async () => { fail(503, 'unavailable', 'Listener remote is unavailable.'); },
        enqueue: item => { resolved = item; }, isIdle: () => false,
      }, { url, enqueueOnly: true, cap: 1 });
      if (!resolved) fail(503, 'unavailable', 'Listener remote is unavailable.');
      return resolved;
    } finally {
      pending.delete(binding.botId);
    }
  }, 'listener.remote.request');
  res.json({ ok: true });
}));

listenerRemoteRoutes.delete('/session', endpoint(async (req, res) => {
  const binding = await authenticate(req);
  service(req).revoke(binding.botId, binding.uid);
  res.json({ ok: true });
}));

listenerRemoteAdminRoutes.use(requireRole('admin'));
listenerRemoteAdminRoutes.post('/bots/:botId/revoke', endpoint(async (req, res) => {
  const botId = Number(req.params.botId);
  if (!Number.isSafeInteger(botId) || botId <= 0) fail(400, 'invalid_request', 'Invalid bot ID.');
  const { uid } = body(req, z.object({ uid: z.string().min(1).max(256).optional() }).strict());
  const row = await req.app.locals.prisma.musicBot.findUnique({ where: { id: botId } });
  if (!row) fail(404, 'not_found', 'Bot not found.');
  const revoked = await runRemoteAudited(req.app.locals.prisma, {
    actor: actorFromRequest(req.user), action: 'listener.remote.revoke',
    connectionId: row.serverConfigId, virtualServerId: row.virtualServerId,
    target: { type: 'music_bot', id: botId },
  }, async () => service(req).revoke(botId, uid));
  res.json({ revoked });
}));
