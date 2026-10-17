import type { Request } from 'express';
import { ListenerRemoteError, type Binding as ListenerRemoteBinding, type ListenerRemoteService } from '../../voice/listener-remote.js';
import { abortable, defaultMediaUrlDeps, runMediaUrlPipeline, type MediaUrlPipelineDeps } from '../../voice/media-url-pipeline.js';
import { validateUrl } from '../../utils/url-validator.js';
import type { QueueItem } from '../../voice/playlist/queue.js';
import { bearer, fail, service } from './shared.js';

const resolvingBots = new WeakMap<ListenerRemoteService, Set<number>>();

/** Longest a pasted link may take to resolve and download before it is refused. */
export const LINK_DEADLINE_MS = 120_000;
/** How often a resolving link checks that its session is still live. */
const SESSION_CHECK_MS = 2_000;

/** Longest the destination check before a link is accepted for work may take. */
const LINK_CHECK_MS = 15_000;

const notAllowed = (): never => fail(400, 'invalid_request', 'This media URL is not allowed.');

/** Refuse a link that is not plain http(s) or carries credentials. No I/O. */
export function checkListenerUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return notAllowed();
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) notAllowed();
}

/**
 * Checks before a link is accepted for work: the session's link-request limit,
 * then the destination (a DNS lookup), within its own short deadline.
 */
export async function checkListenerLink(req: Request, url: string): Promise<void> {
  service(req).checkRequest(bearer(req));
  checkListenerUrl(url);
  const signal = AbortSignal.timeout(LINK_CHECK_MS);
  let valid: boolean;
  try {
    valid = (await abortable(validateUrl(url), signal)).valid;
  } catch {
    fail(504, 'timeout', 'The media link took too long to load.');
  }
  if (!valid) notAllowed();
}

/** Overrides for tests; production uses the defaults above. */
export interface ListenerLinkTimings { deadlineMs?: number; sessionCheckMs?: number }

/**
 * Resolve one pasted media link, already passed by `checkListenerLink`, to a
 * queue item for the listener's bot. At most one link per bot and four in total
 * resolve at a time. The work is cancelled, and its slots released, when the
 * deadline passes, the client disconnects or the session ends; cancellation
 * stops the resolver and downloader processes.
 */
export async function resolveListenerLink(req: Request, binding: ListenerRemoteBinding, url: string): Promise<QueueItem> {
  // Repeated here so this function never resolves a link with credentials, whoever calls it.
  checkListenerUrl(url);
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
  // The finally block clears the deadline and the session checks.
  const deadline = setTimeout(() => abort(504, 'timeout', 'The media link took too long to load.'), timings.deadlineMs ?? LINK_DEADLINE_MS);
  const sessionCheck = setInterval(() => {
    if (!remote.sessionRateKey(session)) abort(401, 'invalid_access', 'Listener access is invalid or expired.');
  }, timings.sessionCheckMs ?? SESSION_CHECK_MS);
  let pending: Set<number> | undefined;
  try {
    // `close` is not emitted again, so a client that left during the earlier lookups is caught here.
    if (req.res?.destroyed || req.socket?.destroyed) disconnected();
    else req.res?.once('close', disconnected);
    pending = resolvingBots.get(remote);
    if (!pending) { pending = new Set(); resolvingBots.set(remote, pending); }
    if (pending.has(binding.botId) || pending.size >= 4) {
      pending = undefined;
      fail(429, 'rate_limited', 'A media request is already pending.');
    }
    pending.add(binding.botId);
    // Use the normal resolver/download path; no admin LAN exception and no playlist background work.
    const deps: MediaUrlPipelineDeps = req.app.locals.mediaUrlPipelineDeps ?? defaultMediaUrlDeps();
    let resolved: QueueItem | undefined;
    await runMediaUrlPipeline(deps, {
      play: () => Promise.reject(new ListenerRemoteError(503, 'unavailable', 'Listener remote is unavailable.')),
      enqueue: item => { resolved = item; }, isIdle: () => false,
    }, { url, enqueueOnly: true, cap: 1, signal });
    if (!resolved) fail(503, 'unavailable', 'Listener remote is unavailable.');
    return resolved;
  } finally {
    clearTimeout(deadline);
    clearInterval(sessionCheck);
    req.res?.off('close', disconnected);
    pending?.delete(binding.botId);
  }
}
