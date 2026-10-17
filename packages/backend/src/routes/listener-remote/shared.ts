import type { Request, Response, RequestHandler } from 'express';
import { createHash, createHmac } from 'node:crypto';
import type { z } from 'zod';
import { ListenerRemoteError, type Binding as ListenerRemoteBinding, type ListenerRemoteService } from '../../voice/listener-remote.js';
import { listHumanMediaListeners, resolveMediaIdentity } from '../../voice/media-listeners.js';
import { authorizeMediaCommand, loadMediaCommandPermissions } from '../../voice/media-command-permissions.js';
import type { VoiceBotManager } from '../../voice/voice-bot-manager.js';
import type { EventBridge } from '../../bot-engine/event-bridge.js';
import { clientRateKey } from '../../utils/client-address.js';
import type { ListenerRemoteRefusalAudit, RefusalEvent } from '../../audit/index.js';
import { config } from '../../config.js';

export function service(req: Request): ListenerRemoteService {
  const value = req.app.locals.listenerRemote;
  if (!value) throw new ListenerRemoteError(503, 'unavailable', 'Listener remote is unavailable.');
  return value;
}

export function fail(status: number, code: string, message: string): never {
  throw new ListenerRemoteError(status, code, message);
}

/**
 * Keyed with a secret of this installation: a plain hash of an IPv4 address
 * could be reversed by trying every address.
 */
let addressKey: Buffer | undefined;

/** Keyed hash of the client address, for refusals that have no verified listener. */
function addressSource(req: Request): string {
  addressKey ??= createHash('sha256').update('ts6:listener-remote:refusal-address:').update(config.jwtSecret).digest();
  return `address:${createHmac('sha256', addressKey).update(clientRateKey(req)).digest('hex')}`;
}

/** The listener verified for this request so far, if any (set by authenticate and authorized). */
function verifiedBinding(res: Response): ListenerRemoteBinding | undefined {
  return res.locals.listenerRemoteBinding as ListenerRemoteBinding | undefined;
}

function remember(req: Request, binding: ListenerRemoteBinding, command?: string): void {
  if (!req.res) return;
  req.res.locals.listenerRemoteBinding = binding;
  if (command) req.res.locals.listenerRemoteCommand = command;
}

/**
 * Count a refusal in the bounded audit totals (see audit/listener-remote-refusals.ts).
 * A refusal inside an opened audit attempt is recorded by that attempt instead.
 */
export function recordRefusal(req: Request, res: Response, err: ListenerRemoteError, detail?: string): void {
  const audit = req.app.locals.listenerRemoteRefusals as ListenerRemoteRefusalAudit | undefined;
  if (!audit || res.locals.listenerRemoteAttemptOpened) return;
  // Administrator routes share the endpoint wrapper but are not listener traffic.
  if (req.baseUrl.startsWith('/api/listener-remote-admin')) return;
  if (err.status === 400 || err.status === 404) {
    audit.countValidation();
    return;
  }
  if (err.status === 503 || err.status === 504) {
    audit.countUnavailable();
    return;
  }
  const binding = verifiedBinding(res);
  const context: Omit<RefusalEvent, 'kind' | 'source'> = binding
    ? { connectionId: binding.serverConfigId, virtualServerId: binding.virtualServerId, botId: binding.botId }
    : {};
  const listener = binding ? listenerActor(binding).username : undefined;
  const command = typeof res.locals.listenerRemoteCommand === 'string' ? res.locals.listenerRemoteCommand : undefined;
  if (err.status === 401) {
    audit.record({ kind: 'auth_failed', source: addressSource(req), detail });
  } else if (err.status === 403 && listener) {
    audit.record({ kind: 'denied', source: listener, ...context, detail: command ?? detail });
  } else if (err.code === 'queue_full' && listener) {
    audit.record({ kind: 'capacity', source: listener, ...context, detail });
  } else if (err.status === 429) {
    audit.record({ kind: 'rate_limited', source: listener ?? listenerRateSource(res) ?? addressSource(req), ...context, detail });
  }
}

/** The listener the guard found for a live session, under the same fingerprint as its other records. */
function listenerRateSource(res: Response): string | undefined {
  const source: unknown = res.locals.listenerRemoteSource;
  return typeof source === 'string' ? source : undefined;
}

const ROUTE_LABELS = new Set(['state', 'library', 'queue', 'requests', 'exchange', 'session']);

/** Fixed label of the route, for refusal totals; never text from the request. */
export function routeLabel(req: Request): string {
  const first = (req.path.split('/').find(Boolean) ?? '').toLowerCase();
  return ROUTE_LABELS.has(first) ? first : 'other';
}

/** Refuse with 403 and record which command was denied. */
export function deny(req: Request, command: string): never {
  if (req.res) req.res.locals.listenerRemoteCommand = command;
  fail(403, 'permission_denied', 'You are not allowed to use this command.');
}

export function endpoint(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((err: unknown) => {
      if (err instanceof ListenerRemoteError) {
        recordRefusal(req, res, err, routeLabel(req));
        if (err.status === 429) res.setHeader('Retry-After', retryAfter(err));
        res.status(err.status).json({ error: err.message, code: err.code });
      } else {
        // Resolver/Query/database exceptions can contain credentials or pasted URLs.
        recordRefusal(req, res, new ListenerRemoteError(503, 'unavailable', 'Listener remote is unavailable.'));
        res.status(503).json({ error: 'Listener remote is unavailable.', code: 'unavailable' });
      }
    });
  };
}

/** Seconds until a rate window resets; 429s without a window (a pending link) keep 60. */
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
    const credential = exchange ? undefined : bearerCredential(req);
    const listener = remote.sessionRateKey(credential);
    const bound = listener ? remote.sessionBinding(credential) : undefined;
    if (listener && bound) {
      res.locals.listenerRemoteRateKey = listener;
      res.locals.listenerRemoteSource = listenerActor(bound).username;
    } else {
      remote.checkIp(clientRateKey(req), exchange);
    }
    next();
  } catch (err) {
    if (err instanceof ListenerRemoteError) {
      recordRefusal(req, res, err, routeLabel(req));
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
  const binding = await service(req).authenticate(bearer(req), async bound => Boolean(await liveIdentity(req, bound)));
  remember(req, binding);
  return binding;
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
  remember(req, binding, command);
  if (!identity || !policy) fail(503, 'unavailable', 'Listener remote is unavailable.');
  if (!authorizeMediaCommand(policy, command, identity, args)) deny(req, command);
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
