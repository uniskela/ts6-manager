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
  '100.100.100.200',  // Alibaba
]);

// BlockList compares address bytes, including compressed/expanded IPv6 and
// IPv4-mapped IPv6, so alternate spellings cannot change the policy.
const neverAllowedIPs = new BlockList();
for (const ip of CLOUD_METADATA_IPS) {
  neverAllowedIPs.addAddress(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}
for (const [ip, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4]] as const) {
  neverAllowedIPs.addSubnet(ip, prefix, 'ipv4');
}
neverAllowedIPs.addAddress('::', 'ipv6');
neverAllowedIPs.addAddress('::1', 'ipv6');
neverAllowedIPs.addSubnet('fe80::', 10, 'ipv6');
neverAllowedIPs.addSubnet('ff00::', 8, 'ipv6');

const localIPs = new BlockList();
for (const [ip, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]] as const) {
  localIPs.addSubnet(ip, prefix, 'ipv4');
}
localIPs.addSubnet('fc00::', 7, 'ipv6');

function inBlockList(blocks: BlockList, ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '');
  const family = isIP(addr);
  return family !== 0 && blocks.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

/** Private/reserved and shared-address-space addresses need operator approval. */
export function isPrivateIP(ip: string): boolean {
  return isNeverAllowedIP(ip) || inBlockList(localIPs, ip);
}

/** Known metadata, loopback, link-local, unspecified and multicast are always denied. */
export function isNeverAllowedIP(ip: string): boolean {
  return inBlockList(neverAllowedIPs, ip);
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

  // Unconditional denial precedes operator LAN allowances.
  if (isNeverAllowedIP(literal)) {
    return { valid: false, error: 'Reserved or cloud metadata IP addresses are blocked' };
  }

  // Check if hostname is a literal IP
  if (isPrivateIP(literal)) {
    if (allowlist?.permits(hostname, literal)) return { valid: true };
    return { valid: false, error: 'Private/reserved IP addresses are blocked' };
  }

  if (isIP(literal)) return { valid: true };

  // Precheck every DNS answer. The sidecar pins and rechecks the address at
  // connection time, including redirects and HLS requests.
  if (!options.skipDnsCheck) {
    try {
      const addresses = await lookup(hostname, { all: true });
      if (addresses.length === 0) throw new Error('No DNS answers');
      for (const { address } of addresses) {
        if (isNeverAllowedIP(address)) {
          return { valid: false, error: `Hostname "${hostname}" resolves to a reserved or cloud metadata IP` };
        }
        if (isPrivateIP(address) && !allowlist?.permits(hostname, address)) {
          return { valid: false, error: `Hostname "${hostname}" resolves to a private IP (${address})` };
        }
      }
    } catch {
      // Fail closed: unresolved hostnames must not bypass SSRF checks
      return { valid: false, error: `Hostname "${hostname}" could not be resolved` };
    }
  }

  return { valid: true };
}
