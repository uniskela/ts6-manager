import type { Request, Response, RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { ListenerRemoteError, type Binding as ListenerRemoteBinding, type ListenerRemoteService } from '../../voice/listener-remote.js';
import { listHumanMediaListeners, resolveMediaIdentity } from '../../voice/media-listeners.js';
import { authorizeMediaCommand, loadMediaCommandPermissions } from '../../voice/media-command-permissions.js';
import type { VoiceBotManager } from '../../voice/voice-bot-manager.js';
import type { EventBridge } from '../../bot-engine/event-bridge.js';
import { clientRateKey } from '../../utils/client-address.js';

export function service(req: Request): ListenerRemoteService {
  const value = req.app.locals.listenerRemote;
  if (!value) throw new ListenerRemoteError(503, 'unavailable', 'Listener remote is unavailable.');
  return value;
}

export function fail(status: number, code: string, message: string): never {
  throw new ListenerRemoteError(status, code, message);
}

export function endpoint(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((err: unknown) => {
      if (err instanceof ListenerRemoteError) {
        if (err.status === 429) res.setHeader('Retry-After', retryAfter(err));
        res.status(err.status).json({ error: err.message, code: err.code });
      } else {
        // Resolver/Query/database exceptions can contain credentials or pasted URLs.
        res.status(503).json({ error: 'Listener remote is unavailable.', code: 'unavailable' });
      }
    });
  };
}

/** Seconds until a rate window resets; 429s without a window (full queue, pending link) keep 60. */
function retryAfter(err: ListenerRemoteError): string {
  return String(err.retryAfter ?? 60);
}

/**
 * The listener key the guard found for a live session, if any. The app-wide
 * remote limiters count such requests per listener, in a store only verified
 * listeners can fill, and everything else per client address.
 */
export function listenerRemoteListenerKey(res: Response): string | undefined {
  const listener: unknown = res.locals.listenerRemoteRateKey;
  return typeof listener === 'string' ? listener : undefined;
}

export const listenerRemoteIpGuard: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const remote = service(req);
    const exchange = /^\/exchange\/?$/i.test(req.path);
    // A live session is limited per listener when it authenticates, so listeners
    // sharing one address do not use up each other's budget. Everything else,
    // including unknown credentials, counts against the client address.
    const listener = exchange ? undefined : remote.sessionRateKey(bearerCredential(req));
    if (listener) res.locals.listenerRemoteRateKey = listener;
    else remote.checkIp(clientRateKey(req), exchange);
    next();
  } catch (err) {
    if (err instanceof ListenerRemoteError) {
      if (err.status === 429) res.setHeader('Retry-After', retryAfter(err));
      res.status(err.status).json({ error: err.message, code: err.code });
    } else res.status(503).json({ error: 'Listener remote is unavailable.', code: 'unavailable' });
  }
};

export function bearerCredential(req: Request): string | undefined {
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') ?? '')?.[1];
}

export function bearer(req: Request): string {
  const credential = bearerCredential(req);
  if (!credential) fail(401, 'invalid_access', 'Listener access is invalid or expired.');
  return credential;
}

export function botFor(req: Request, binding: ListenerRemoteBinding) {
  const manager = req.app.locals.voiceBotManager as VoiceBotManager | undefined;
  const bot = manager?.getBot(binding.botId);
  if (bot?.currentConfig.serverConfigId !== binding.serverConfigId
    || bot.getCurrentChannelId() !== binding.channelId
    || !['connected', 'playing', 'paused'].includes(bot.status)) return null;
  return bot;
}

/** The bound bot, once `botFor` has confirmed it still serves the listener's channel. */
export type ListenerBot = NonNullable<ReturnType<typeof botFor>>;

/** Verify the bound bot's server scope and current human identity, never browser claims. */
export async function liveIdentity(req: Request, binding: ListenerRemoteBinding) {
  const bot = botFor(req, binding);
  const bridge = req.app.locals.eventBridge as EventBridge | undefined;
  if (!bot || !bridge) return null;
  const row = await req.app.locals.prisma.musicBot.findUnique({
    where: { id: binding.botId }, select: { serverConfigId: true, virtualServerId: true },
  });
  if (row?.serverConfigId !== binding.serverConfigId || row.virtualServerId !== binding.virtualServerId) return null;
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

export async function authenticate(req: Request) {
  return service(req).authenticate(bearer(req), async binding => Boolean(await liveIdentity(req, binding)));
}

export async function authorized(req: Request, command: string, args = '') {
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

export function body<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) fail(400, 'invalid_request', 'Invalid listener request.');
  return parsed.data;
}

export function listenerActor(binding: ListenerRemoteBinding) {
  // Reserved non-user actor; the UID fingerprint supports correlation without retaining identity text.
  return { id: 0, username: `listener:${createHash('sha256').update(binding.uid).digest('hex')}` };
}
