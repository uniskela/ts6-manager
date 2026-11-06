import type { Request } from 'express';
import { LISTENER_MAX_DURATION_SEC, type ListenerTrackMeta } from '../../voice/audio/listener-music.js';
import { MediaCacheError } from '../../voice/audio/media-cache.js';
import { downloadYouTube } from '../../voice/audio/youtube.js';
import { ListenerRemoteError, type Binding as ListenerRemoteBinding, type ListenerRemoteService } from '../../voice/listener-remote.js';
import { abortable, defaultMediaUrlDeps, runMediaUrlPipeline, type MediaUrlPipelineDeps } from '../../voice/media-url-pipeline.js';
import { validateUrl } from '../../utils/url-validator.js';
import type { QueueItem } from '../../voice/playlist/queue.js';
import {
  LISTENER_MAX_DOWNLOAD_BYTES,
  probeListenerLinkMeta,
  refuseListenerDuration,
} from './duration.js';
import { bearer, fail, service } from './shared.js';

const resolvingBots = new WeakMap<ListenerRemoteService, Set<number>>();

/** Longest a pasted link may take, from its destination check to the end of its download. */
export const LINK_DEADLINE_MS = 120_000;
/** How often a pending link checks that its session is still live. */
const SESSION_CHECK_MS = 2_000;

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';

const notAllowed = (): never => fail(400, 'invalid_request', 'This media URL is not allowed.');

/** Injectable probe for tests; production dumps yt-dlp metadata before download. */
export type ListenerLinkProbe = (url: string, signal?: AbortSignal) => Promise<ListenerTrackMeta>;

/** Map cache measured-duration refusals onto the listener 422 codes. */
function mapMeasuredDurationError(err: unknown): never {
  if (err instanceof MediaCacheError && err.code === 'too_long') {
    refuseListenerDuration({ durationSec: LISTENER_MAX_DURATION_SEC + 1 });
  }
  if (err instanceof MediaCacheError && err.code === 'duration_unknown') {
    refuseListenerDuration({ durationSec: null });
  }
  throw err;
}

/** Listener paste downloads: 15-minute match-filter, size cap, and measured-duration gate. */
async function listenerBoundedDownloadTrack(url: string, signal?: AbortSignal): Promise<QueueItem> {
  try {
    const { filePath, info } = await downloadYouTube(url, MUSIC_DIR, undefined, signal, {
      maxDurationSec: LISTENER_MAX_DURATION_SEC,
      maxFilesizeBytes: LISTENER_MAX_DOWNLOAD_BYTES,
    });
    return {
      id: `yt_${info.id}`,
      title: info.title,
      artist: info.artist,
      duration: info.duration,
      filePath,
      source: 'youtube' as const,
      sourceUrl: url,
    };
  } catch (err) {
    mapMeasuredDurationError(err);
  }
}

/** Pipeline deps for one pasted link: duration gate before and after download. */
function listenerLinkDeps(req: Request): MediaUrlPipelineDeps {
  const injected = req.app.locals.mediaUrlPipelineDeps as MediaUrlPipelineDeps | undefined;
  const base = injected ?? {
    ...defaultMediaUrlDeps(),
    downloadTrack: listenerBoundedDownloadTrack,
  };
  const probe: ListenerLinkProbe = req.app.locals.listenerLinkProbe ?? probeListenerLinkMeta;
  return {
    ...base,
    downloadTrack: async (url, signal) => {
      refuseListenerDuration(await probe(url, signal));
      let item: QueueItem;
      try {
        item = await base.downloadTrack(url, signal);
      } catch (err) {
        mapMeasuredDurationError(err);
      }
      refuseListenerDuration({ durationSec: item.duration ?? null });
      return item;
    },
  };
}

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
      // Duration/live rules (C1a) run inside the download wrapper before and after the file lands.
      // No admin LAN exception and no playlist background work (cap 1 = first playlist item only).
      const deps = listenerLinkDeps(req);
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
