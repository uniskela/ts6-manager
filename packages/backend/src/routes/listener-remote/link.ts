import type { Request } from 'express';
import { ListenerRemoteError, type Binding as ListenerRemoteBinding, type ListenerRemoteService } from '../../voice/listener-remote.js';
import { abortable, defaultMediaUrlDeps, runMediaUrlPipeline, type MediaUrlPipelineDeps } from '../../voice/media-url-pipeline.js';
import { validateUrl } from '../../utils/url-validator.js';
import type { QueueItem } from '../../voice/playlist/queue.js';
import { bearer, fail, service } from './shared.js';

const resolvingBots = new WeakMap<ListenerRemoteService, Set<number>>();

/** Longest a pasted link may take, from its destination check to the end of its download. */
export const LINK_DEADLINE_MS = 120_000;
/** How often a pending link checks that its session is still live. */
const SESSION_CHECK_MS = 2_000;

const notAllowed = (): never => fail(400, 'invalid_request', 'This media URL is not allowed.');

/**
 * Refuse, without any lookup, a link that is not plain http(s), carries
 * credentials, or names a blocked host or a private, loopback or reserved
 * address literally.
 */
export async function checkListenerUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return notAllowed();
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) notAllowed();
  if (!(await validateUrl(url, { skipDnsCheck: true })).valid) notAllowed();
}

/** Overrides for tests; production uses the defaults above. */
export interface ListenerLinkTimings { deadlineMs?: number; sessionCheckMs?: number }

/** One pasted link's work, from its checks to its download, under one deadline. */
export interface ListenerLink {
  /**
   * The checks before any media work: the session's link-request limit, a free
   * resolving slot (one per bot, four in total), then the destination (DNS).
   */
  check(): Promise<void>;
  /** Resolve the checked link to a queue item. */
  resolve(): Promise<QueueItem>;
  /** Clear the deadline and checks and free the slot. Safe to call twice. */
  dispose(): void;
}

/**
 * Start one pasted link for the listener's bot. The deadline, the session
 * checks and the client-disconnect check cover both `check` and `resolve`;
 * any of them cancels the work, and cancellation stops the resolver and
 * downloader processes. Call `dispose` when done.
 */
export function listenerLink(req: Request, binding: ListenerRemoteBinding, url: string): ListenerLink {
  const session = bearer(req);
  const remote = service(req);
  const timings: ListenerLinkTimings = req.app.locals.listenerLinkTimings ?? {};
  const controller = new AbortController();
  const { signal } = controller;
  const abort = (status: number, code: string, message: string) => {
    if (!signal.aborted) controller.abort(new ListenerRemoteError(status, code, message));
  };
  const disconnected = () => {
    if (!req.res?.writableEnded) abort(503, 'unavailable', 'Listener remote is unavailable.');
  };
  let deadline: NodeJS.Timeout | undefined;
  let sessionCheck: NodeJS.Timeout | undefined;
  let pending: Set<number> | undefined;
  let checked = false;

  return {
    async check() {
      remote.checkRequest(session);
      deadline = setTimeout(() => abort(504, 'timeout', 'The media link took too long to load.'), timings.deadlineMs ?? LINK_DEADLINE_MS);
      sessionCheck = setInterval(() => {
        if (!remote.sessionRateKey(session)) abort(401, 'invalid_access', 'Listener access is invalid or expired.');
      }, timings.sessionCheckMs ?? SESSION_CHECK_MS);
      // `close` is not emitted again, so a client that left during the earlier lookups is caught here.
      if (req.res?.destroyed || req.socket?.destroyed) disconnected();
      else req.res?.once('close', disconnected);
      let bots = resolvingBots.get(remote);
      if (!bots) { bots = new Set(); resolvingBots.set(remote, bots); }
      if (bots.has(binding.botId) || bots.size >= 4) fail(429, 'rate_limited', 'A media request is already pending.');
      bots.add(binding.botId);
      pending = bots;
      signal.throwIfAborted();
      if (!(await abortable(validateUrl(url), signal)).valid) notAllowed();
      checked = true;
    },

    async resolve() {
      if (!checked) fail(503, 'unavailable', 'Listener remote is unavailable.');
      // Use the normal resolver/download path; no admin LAN exception and no playlist background work.
      const deps: MediaUrlPipelineDeps = req.app.locals.mediaUrlPipelineDeps ?? defaultMediaUrlDeps();
      let resolved: QueueItem | undefined;
      await runMediaUrlPipeline(deps, {
        play: () => Promise.reject(new ListenerRemoteError(503, 'unavailable', 'Listener remote is unavailable.')),
        enqueue: item => { resolved = item; }, isIdle: () => false,
      }, { url, enqueueOnly: true, cap: 1, signal });
      if (!resolved) fail(503, 'unavailable', 'Listener remote is unavailable.');
      return resolved;
    },

    dispose() {
      clearTimeout(deadline);
      clearInterval(sessionCheck);
      req.res?.off('close', disconnected);
      pending?.delete(binding.botId);
      pending = undefined;
    },
  };
}

/** Check and resolve one pasted link in one go (see `listenerLink`). */
export async function resolveListenerLink(req: Request, binding: ListenerRemoteBinding, url: string): Promise<QueueItem> {
  await checkListenerUrl(url);
  const link = listenerLink(req, binding, url);
  try {
    await link.check();
    return await link.resolve();
  } finally {
    link.dispose();
  }
}
