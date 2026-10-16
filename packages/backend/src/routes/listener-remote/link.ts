import type { Request } from 'express';
import { ListenerRemoteError, type Binding as ListenerRemoteBinding, type ListenerRemoteService } from '../../voice/listener-remote.js';
import { defaultMediaUrlDeps, runMediaUrlPipeline, type MediaUrlPipelineDeps } from '../../voice/media-url-pipeline.js';
import { validateUrl } from '../../utils/url-validator.js';
import type { QueueItem } from '../../voice/playlist/queue.js';
import { bearer, fail, service } from './shared.js';

const resolvingBots = new WeakMap<ListenerRemoteService, Set<number>>();

/** Longest a pasted link may take to resolve and download before it is refused. */
export const LINK_DEADLINE_MS = 120_000;
/** How often a resolving link checks that its session is still live. */
const SESSION_CHECK_MS = 2_000;

/** Overrides for tests; production uses the defaults above. */
export interface ListenerLinkTimings { deadlineMs?: number; sessionCheckMs?: number }

/**
 * Resolve one pasted media link to a queue item for the listener's bot. It
 * counts against the session's request limit, and at most one link per bot
 * and four in total resolve at a time. The work is cancelled, and its slots
 * released, when the deadline passes, the client disconnects or the session
 * ends; cancellation stops the resolver and downloader processes.
 */
export async function resolveListenerLink(req: Request, binding: ListenerRemoteBinding, url: string): Promise<QueueItem> {
  const session = bearer(req);
  service(req).checkRequest(session);
  const parsed = new URL(url);
  if (parsed.username || parsed.password || !(await validateUrl(url)).valid) {
    fail(400, 'invalid_request', 'This media URL is not allowed.');
  }
  const remote = service(req);
  let pending = resolvingBots.get(remote);
  if (!pending) { pending = new Set(); resolvingBots.set(remote, pending); }
  if (pending.has(binding.botId) || pending.size >= 4) fail(429, 'rate_limited', 'A media request is already pending.');
  pending.add(binding.botId);
  const timings: ListenerLinkTimings = req.app.locals.listenerLinkTimings ?? {};
  const controller = new AbortController();
  const abort = (status: number, code: string, message: string) => {
    if (!controller.signal.aborted) controller.abort(new ListenerRemoteError(status, code, message));
  };
  const deadline = setTimeout(() => abort(504, 'timeout', 'The media link took too long to load.'), timings.deadlineMs ?? LINK_DEADLINE_MS);
  const sessionCheck = setInterval(() => {
    if (!remote.sessionRateKey(session)) abort(401, 'invalid_access', 'Listener access is invalid or expired.');
  }, timings.sessionCheckMs ?? SESSION_CHECK_MS);
  const disconnected = () => {
    if (!req.res?.writableEnded) abort(503, 'unavailable', 'Listener remote is unavailable.');
  };
  req.res?.once('close', disconnected);
  try {
    // Use the normal resolver/download path; no admin LAN exception and no playlist background work.
    const deps: MediaUrlPipelineDeps = req.app.locals.mediaUrlPipelineDeps ?? defaultMediaUrlDeps();
    let resolved: QueueItem | undefined;
    await runMediaUrlPipeline(deps, {
      play: () => Promise.reject(new ListenerRemoteError(503, 'unavailable', 'Listener remote is unavailable.')),
      enqueue: item => { resolved = item; }, isIdle: () => false,
    }, { url, enqueueOnly: true, cap: 1, signal: controller.signal });
    if (!resolved) fail(503, 'unavailable', 'Listener remote is unavailable.');
    return resolved;
  } finally {
    clearTimeout(deadline);
    clearInterval(sessionCheck);
    req.res?.off('close', disconnected);
    pending.delete(binding.botId);
  }
}
