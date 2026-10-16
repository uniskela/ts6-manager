import type { Request } from 'express';
import { ListenerRemoteError, type Binding as ListenerRemoteBinding, type ListenerRemoteService } from '../../voice/listener-remote.js';
import { defaultMediaUrlDeps, runMediaUrlPipeline, type MediaUrlPipelineDeps } from '../../voice/media-url-pipeline.js';
import { validateUrl } from '../../utils/url-validator.js';
import type { QueueItem } from '../../voice/playlist/queue.js';
import { bearer, fail, service } from './shared.js';

const resolvingBots = new WeakMap<ListenerRemoteService, Set<number>>();

/**
 * Resolve one pasted media link to a queue item for the listener's bot. It
 * counts against the session's request limit, and at most one link per bot
 * and four in total resolve at a time.
 */
export async function resolveListenerLink(req: Request, binding: ListenerRemoteBinding, url: string): Promise<QueueItem> {
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
      play: () => Promise.reject(new ListenerRemoteError(503, 'unavailable', 'Listener remote is unavailable.')),
      enqueue: item => { resolved = item; }, isIdle: () => false,
    }, { url, enqueueOnly: true, cap: 1 });
    if (!resolved) fail(503, 'unavailable', 'Listener remote is unavailable.');
    return resolved;
  } finally {
    pending.delete(binding.botId);
  }
}
