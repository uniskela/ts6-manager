import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '../middleware/error-handler.js';

const BLOCKED_HOSTNAMES = new Set([
  'metadata',
  'metadata.google',
  'metadata.google.internal',
  'kubernetes.default.svc',
]);

const BLOCKED_IPV4 = new Set([
  '169.254.169.254', // AWS/GCP/Azure metadata
  '169.254.170.2', // GCP metadata
  '100.100.100.200', // Alibaba metadata
  '0.0.0.0',
]);

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

function allowPrivateHosts(): boolean {
  const raw = process.env.TS_ALLOW_PRIVATE_HOSTS;
  if (raw === 'false' || raw === '0') return false;
  return true;
}

function normalizeHostInput(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) throw new AppError(400, 'Host is required');

  if (/[\s/\\?#@]/.test(trimmed) || trimmed.includes('://')) {
    throw new AppError(400, 'Host must be a hostname or IP address without URL path or credentials');
  }

  let normalized = trimmed;
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }

  if (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized.toLowerCase();
}

function parseIpv4(host: string): string | null {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return null;
  const octets = host.split('.').map((p) => Number(p));
  if (octets.some((o) => o > 255)) return null;
  return host;
}

function parseIpv6(host: string): string | null {
  if (!net.isIP(host)) return null;
  return net.isIPv6(host) ? host : null;
}

function isPrivateOrLoopbackIp(host: string): boolean {
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map((p) => Number(p));
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (ipVersion === 6) {
    const lower = host.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  }
  return false;
}

function assertNotBlockedHost(host: string): void {
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new AppError(400, 'Host is not allowed');
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    if (BLOCKED_IPV4.has(ipv4)) {
      throw new AppError(400, 'Host is not allowed');
    }
    if (!allowPrivateHosts() && isPrivateOrLoopbackIp(ipv4)) {
      throw new AppError(400, 'Private or loopback hosts are disabled (set TS_ALLOW_PRIVATE_HOSTS=true to allow)');
    }
    return;
  }

  const ipv6 = parseIpv6(host);
  if (ipv6) {
    if (!allowPrivateHosts() && isPrivateOrLoopbackIp(ipv6)) {
      throw new AppError(400, 'Private or loopback hosts are disabled (set TS_ALLOW_PRIVATE_HOSTS=true to allow)');
    }
    return;
  }

  if (!HOSTNAME_RE.test(host)) {
    throw new AppError(400, 'Invalid hostname');
  }
}

/**
 * Validate and normalize a TeamSpeak server host before outbound WebQuery/SSH connections.
 * Rejects URL tricks and known cloud-metadata targets to reduce SSRF risk.
 */
export function sanitizeTsServerHost(host: string): string {
  const normalized = normalizeHostInput(host);
  assertNotBlockedHost(normalized);
  return normalized;
}

export function validateTsServerPort(port: unknown, fallback: number): number {
  const value = port === undefined || port === null || port === '' ? fallback : Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new AppError(400, 'Port must be an integer between 1 and 65535');
  }
  return value;
}

/** Build an origin URL from validated host/port only (no user-controlled URL parsing). */
export function buildTsServerOrigin(host: string, port: number, useHttps: boolean): string {
  const safeHost = sanitizeTsServerHost(host);
  const safePort = validateTsServerPort(port, port);
  const protocol = useHttps ? 'https' : 'http';

  if (net.isIPv6(safeHost)) {
    return `${protocol}://[${safeHost}]:${safePort}`;
  }

  return `${protocol}://${safeHost}:${safePort}`;
}

/**
 * Optional DNS resolution guard: reject hosts that resolve to blocked addresses.
 * Used for draft connection tests where hostnames may point at metadata endpoints.
 */
export async function assertResolvableTsServerHost(host: string): Promise<string> {
  const safeHost = sanitizeTsServerHost(host);

  if (net.isIP(safeHost)) {
    assertNotBlockedHost(safeHost);
    return safeHost;
  }

  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.lookup(safeHost, { all: true, verbatim: true });
  } catch {
    throw new AppError(400, 'Host could not be resolved');
  }

  if (addresses.length === 0) {
    throw new AppError(400, 'Host could not be resolved');
  }

  for (const entry of addresses) {
    const resolved = entry.address;
    if (BLOCKED_IPV4.has(resolved) || BLOCKED_HOSTNAMES.has(resolved)) {
      throw new AppError(400, 'Host resolves to a blocked address');
    }
    if (!allowPrivateHosts() && isPrivateOrLoopbackIp(resolved)) {
      throw new AppError(400, 'Host resolves to a private or loopback address');
    }
  }

  return safeHost;
}
