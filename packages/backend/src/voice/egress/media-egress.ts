import { MediaEgressProxy, type EgressJob, type UpstreamProxy } from './media-egress-proxy.js';

/**
 * Process-wide media egress settings and the shared checking proxy.
 *
 * MEDIA_EGRESS_PROXY=off is an emergency administrator setting: downloads then
 * connect directly, and only YouTube links and searches are accepted, so
 * untrusted users do not keep arbitrary media links while protection is off.
 * MEDIA_UPSTREAM_PROXY chains approved connections through an outbound proxy.
 */

/** Fixed message when a media job cannot run through the proxy. */
export const MEDIA_LINK_UNAVAILABLE = 'This media link could not be loaded.';

/** Fixed message for links refused while the proxy is switched off. */
export const MEDIA_EGRESS_OFF_REFUSAL =
  'Only YouTube links and searches are available while media download protection is switched off (MEDIA_EGRESS_PROXY=off).';

export class MediaEgressError extends Error {
  constructor(message = MEDIA_LINK_UNAVAILABLE) {
    super(message);
    this.name = 'MediaEgressError';
  }
}

export function mediaEgressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MEDIA_EGRESS_PROXY ?? '').trim().toLowerCase() !== 'off';
}

/** Parse MEDIA_UPSTREAM_PROXY (`http://[user:pass@]host:port`). Throws on anything else. */
export function parseUpstreamProxy(value: string | undefined): UpstreamProxy | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MEDIA_UPSTREAM_PROXY must be an http://host:port URL');
  }
  if (url.protocol !== 'http:' || !url.hostname || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('MEDIA_UPSTREAM_PROXY must be an http://host:port URL');
  }
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  const authorization = url.username || url.password ? `Basic ${Buffer.from(credentials).toString('base64')}` : undefined;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 80, authorization };
}

const PROXY_VARIABLE = /(^|_)proxy$/i;
const OUTBOUND_PROXY = /^(https?|ftp|all|no)_proxy$/i;

/** Outbound proxy variables in the backend's environment that media jobs no longer use. */
export function ignoredProxyVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((name) => OUTBOUND_PROXY.test(name) && env[name]);
}

/**
 * Environment for a process that must use `proxyUrl`: every *_proxy variable
 * (any letter case, including no_proxy and all_proxy) is removed, then the
 * http/https variables are set to the job's proxy. ffmpeg started by yt-dlp
 * reads these.
 */
export function egressEnvironment(proxyUrl: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!PROXY_VARIABLE.test(name)) out[name] = value;
  }
  out.http_proxy = proxyUrl;
  out.https_proxy = proxyUrl;
  out.HTTP_PROXY = proxyUrl;
  out.HTTPS_PROXY = proxyUrl;
  return out;
}

let proxy: MediaEgressProxy | undefined;
let configError: string | undefined;
let lastOffWarning = 0;

function sharedProxy(): MediaEgressProxy {
  if (!proxy) {
    try {
      proxy = new MediaEgressProxy({ upstream: parseUpstreamProxy(process.env.MEDIA_UPSTREAM_PROXY) });
    } catch (err) {
      configError = (err as Error).message;
      throw new MediaEgressError();
    }
  }
  return proxy;
}

/** Why media downloads cannot use the proxy as configured, or undefined. Never includes values. */
export function mediaEgressProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!mediaEgressEnabled(env)) return undefined;
  try {
    parseUpstreamProxy(env.MEDIA_UPSTREAM_PROXY);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Replace the shared proxy (tests). Pass undefined to reset. */
export function setMediaEgressProxyForTests(value: MediaEgressProxy | undefined): void {
  proxy = value;
  configError = undefined;
}

/**
 * Start the shared proxy at boot and log how media downloads connect. Never
 * logs proxy credentials or variable values.
 */
export async function startMediaEgress(log: Pick<Console, 'log' | 'warn'> = console): Promise<void> {
  if (!mediaEgressEnabled()) {
    log.warn('[MediaEgress] DISABLED by MEDIA_EGRESS_PROXY=off. Media downloads connect directly and are not checked at connection time; only YouTube links and searches are accepted until it is switched back on.');
    return;
  }
  const ignored = ignoredProxyVariables();
  if (ignored.length > 0 && !process.env.MEDIA_UPSTREAM_PROXY) {
    log.warn(`[MediaEgress] ${ignored.join(', ')} is set but media downloads no longer use it. Set MEDIA_UPSTREAM_PROXY if downloads must go through an outbound proxy.`);
  }
  try {
    await sharedProxy().start();
    log.log(`[MediaEgress] enforcing (upstream: ${process.env.MEDIA_UPSTREAM_PROXY?.trim() ? 'set' : 'none'})`);
  } catch (err) {
    log.warn(`[MediaEgress] Media downloads are unavailable: ${configError ?? (err as Error).message}`);
  }
}

/** True for yt-dlp search targets and https links to YouTube hosts. */
function isYouTubeTarget(target: string): boolean {
  if (/^ytsearch\d*:/.test(target)) return true;
  try {
    const url = new URL(target);
    let host = url.hostname.toLowerCase();
    while (host.endsWith('.')) host = host.slice(0, -1);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com'));
  } catch {
    return false;
  }
}

/**
 * Access for one media job. Returns null when protection is switched off (the
 * job then connects directly), after refusing anything but YouTube. Throws
 * MediaEgressError when the proxy cannot be used, so a job never falls back
 * to a direct connection.
 */
export async function acquireMediaEgress(target: string, ttlMs: number): Promise<EgressJob | null> {
  if (!mediaEgressEnabled()) {
    if (Date.now() - lastOffWarning > 60_000) {
      lastOffWarning = Date.now();
      console.warn('[MediaEgress] DISABLED (MEDIA_EGRESS_PROXY=off): a media download is connecting directly.');
    }
    if (!isYouTubeTarget(target)) throw new MediaEgressError(MEDIA_EGRESS_OFF_REFUSAL);
    return null;
  }
  try {
    return await sharedProxy().issue(ttlMs);
  } catch (err) {
    if (err instanceof MediaEgressError) throw err;
    throw new MediaEgressError();
  }
}
