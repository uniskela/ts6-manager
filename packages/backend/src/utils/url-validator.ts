import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.internal',
]);

const CLOUD_METADATA_IPS = new Set([
  '169.254.169.254',  // AWS, GCP, Azure
  'fd00:ec2::254',    // AWS IPv6
]);

/**
 * Check if an IP address is in a private/reserved range.
 */
export function isPrivateIP(ip: string): boolean {
  // IPv4
  const parts = ip.split('.');
  if (parts.length === 4) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;                           // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16
    if (a === 127) return true;                           // 127.0.0.0/8
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 (link-local)
    if (a === 0) return true;                             // 0.0.0.0/8
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;                       // loopback
  if (lower.startsWith('fe80:')) return true;              // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('::ffff:')) {                      // IPv4-mapped IPv6
    const mapped = lower.slice(7);
    return isPrivateIP(mapped);
  }

  return false;
}

/**
 * Private addresses no allowlist can open: loopback, link-local, "this
 * network" and cloud metadata. From inside a container, loopback is the
 * container itself, never the LAN device an operator means.
 */
export function isNeverAllowedIP(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (CLOUD_METADATA_IPS.has(lower)) return true;
  if (lower.startsWith('::ffff:')) return isNeverAllowedIP(lower.slice(7));
  const parts = lower.split('.');
  if (parts.length === 4) {
    const [a, b] = parts.map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  return lower === '::1' || lower === '::' || lower.startsWith('fe80:');
}

/**
 * Operator-approved LAN hosts (IPs, CIDRs or hostnames) for sources the admin
 * configured, such as IPTV playlists on a local proxy. Never used for URLs
 * typed by users.
 */
export class LocalHostAllowlist {
  private readonly blocks = new BlockList();
  private readonly hosts = new Set<string>();
  private size = 0;

  add(entry: string): boolean {
    const value = entry.trim().toLowerCase();
    if (!value) return false;
    const [addr, prefix] = value.split('/');
    const family = isIP(addr);
    if (family) {
      if (isNeverAllowedIP(addr)) return false;
      const type = family === 6 ? 'ipv6' : 'ipv4';
      if (prefix === undefined) {
        this.blocks.addAddress(addr, type);
      } else {
        const bits = Number(prefix);
        const max = family === 6 ? 128 : 32;
        // At least a /8 (IPv4) or /16 (IPv6): no "allow everything" entries.
        const min = family === 6 ? 16 : 8;
        if (!/^\d+$/.test(prefix) || bits < min || bits > max) return false;
        this.blocks.addSubnet(addr, bits, type);
      }
    } else {
      if (prefix !== undefined || !HOSTNAME_RE.test(value) || BLOCKED_HOSTNAMES.has(value)) return false;
      this.hosts.add(value);
    }
    this.size++;
    return true;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  /** True when the (private) address may be used for `hostname`. */
  permits(hostname: string, ip: string): boolean {
    const addr = ip.replace(/^\[|\]$/g, '');
    if (isNeverAllowedIP(addr)) return false;
    if (this.hosts.has(hostname.toLowerCase())) return true;
    const family = isIP(addr);
    if (!family) return false;
    return this.blocks.check(addr, family === 6 ? 'ipv6' : 'ipv4');
  }
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Build an allowlist, returning entries that were rejected. */
export function parseLocalHostAllowlist(entries: readonly string[]): { allowlist: LocalHostAllowlist; invalid: string[] } {
  const allowlist = new LocalHostAllowlist();
  const invalid: string[] = [];
  for (const entry of entries) {
    if (!allowlist.add(entry)) invalid.push(entry);
  }
  return { allowlist, invalid };
}

export interface ValidateUrlOptions {
  allowedProtocols?: string[];
  skipDnsCheck?: boolean;
  /** Operator-approved LAN hosts; only for admin-configured sources. */
  localAllowlist?: LocalHostAllowlist;
}

export interface ValidateUrlResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a URL for safety against SSRF attacks.
 * Blocks private IPs, cloud metadata endpoints, and non-HTTP protocols.
 */
export async function validateUrl(
  url: string,
  options: ValidateUrlOptions = {},
): Promise<ValidateUrlResult> {
  const allowedProtocols = options.allowedProtocols || ['http:', 'https:'];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Protocol check
  if (!allowedProtocols.includes(parsed.protocol)) {
    return { valid: false, error: `Protocol "${parsed.protocol}" is not allowed. Use: ${allowedProtocols.join(', ')}` };
  }

  // Hostname checks
  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, error: `Hostname "${hostname}" is blocked` };
  }

  if (CLOUD_METADATA_IPS.has(hostname)) {
    return { valid: false, error: 'Cloud metadata endpoint is blocked' };
  }

  const allowlist = options.localAllowlist;
  const literal = hostname.replace(/^\[|\]$/g, '');

  // Check if hostname is a literal IP
  if (isPrivateIP(literal)) {
    if (allowlist?.permits(hostname, literal)) return { valid: true };
    return { valid: false, error: 'Private/reserved IP addresses are blocked' };
  }

  // DNS resolution check (prevents DNS rebinding)
  if (!options.skipDnsCheck) {
    try {
      const { address } = await lookup(hostname);
      if (isPrivateIP(address)) {
        if (allowlist?.permits(hostname, address)) return { valid: true };
        return { valid: false, error: `Hostname "${hostname}" resolves to a private IP (${address})` };
      }
      if (CLOUD_METADATA_IPS.has(address)) {
        return { valid: false, error: `Hostname "${hostname}" resolves to a cloud metadata IP` };
      }
    } catch {
      // Fail closed: unresolved hostnames must not bypass SSRF checks
      return { valid: false, error: `Hostname "${hostname}" could not be resolved` };
    }
  }

  return { valid: true };
}

export interface ResolveRedirectsOptions extends ValidateUrlOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Follow a remote media URL's HTTP redirects here, checking every hop with
 * validateUrl, and return the final URL. ffmpeg follows redirects on its own,
 * so without this an allowed URL could send the sidecar to an address the
 * guard blocks. The body is not read: only the status and Location matter.
 */
export async function resolveRedirectsSafely(url: string, options: ResolveRedirectsOptions = {}): Promise<string> {
  const { maxRedirects = 5, timeoutMs = 10_000, fetchImpl = fetch, ...validate } = options;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await validateUrl(current, validate);
    if (!check.valid) {
      throw new Error(hop === 0 ? `Video source blocked: ${check.error}` : `Video source redirect blocked: ${check.error}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: controller.signal });
    } catch (err: any) {
      throw new Error(`Could not reach the video source: ${err?.name === 'AbortError' ? 'timed out' : err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
    try { await res.body?.cancel(); } catch { /* already closed */ }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return current;
    current = new URL(location, current).href;
  }
  throw new Error(`Video source redirected more than ${maxRedirects} times`);
}
