import { BlockList, isIP } from 'node:net';
import { isNeverAllowedIP, isPrivateIP } from '../../utils/url-validator.js';

/**
 * Address policy for media downloads (yt-dlp, and ffmpeg reading what yt-dlp
 * resolved). Stricter than the URL check: no LAN allowance at all, a few more
 * reserved ranges, and IPv6 forms that embed an IPv4 address are judged by
 * that IPv4 address.
 */

/** Ports a media download may connect to. */
export const MEDIA_EGRESS_PORTS: ReadonlySet<number> = new Set([80, 443]);

/** Special-purpose ranges (RFC 6890 registries) that are never a public media host. */
const reserved = new BlockList();
for (const [ip, prefix] of [
  ['192.0.0.0', 24], // NOSONAR: IETF protocol assignments (denied)
  ['192.0.2.0', 24], // NOSONAR: documentation (denied)
  ['192.88.99.0', 24], // NOSONAR: deprecated 6to4 relay anycast (denied)
  ['198.18.0.0', 15], // NOSONAR: benchmarking (denied)
  ['198.51.100.0', 24], // NOSONAR: documentation (denied)
  ['203.0.113.0', 24], // NOSONAR: documentation (denied)
  ['240.0.0.0', 4], // NOSONAR: reserved, including broadcast (denied)
] as const) { // NOSONAR: Fixed reserved ranges define the egress denylist.
  reserved.addSubnet(ip, prefix, 'ipv4');
}
for (const [ip, prefix] of [
  ['100::', 64], // NOSONAR: discard (denied)
  ['2001::', 23], // NOSONAR: IETF protocol assignments, including Teredo, benchmarking and ORCHID (denied)
  ['2001:db8::', 32], // NOSONAR: documentation (denied)
  ['3fff::', 20], // NOSONAR: documentation (denied)
  ['64:ff9b:1::', 48], // NOSONAR: local-use NAT64; the IPv4 address can sit anywhere, so it cannot be checked (denied)
  ['fec0::', 10], // NOSONAR: deprecated site-local (denied)
] as const) { // NOSONAR: Fixed reserved ranges define the egress denylist.
  reserved.addSubnet(ip, prefix, 'ipv6');
}

/** Expand an IPv6 address to its 16 bytes, or null when it is not one. */
export function ipv6Bytes(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const tail: number[] = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    tail.push(...dotted[1].split('.').map(Number));
    text = text.slice(0, -dotted[1].length) + '0:0';
  }
  const [head, rest] = text.split('::');
  const words = (part: string | undefined) => (part ? part.split(':').filter(Boolean).map((w) => Number.parseInt(w, 16)) : []);
  const left = words(head);
  const right = words(rest);
  const fill = rest === undefined ? [] : new Array(8 - left.length - right.length).fill(0);
  const all = [...left, ...fill, ...right];
  if (all.length !== 8) return null;
  const bytes = all.flatMap((w) => [w >> 8, w & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * The IPv4 address an IPv6 address stands for, when it is IPv4-mapped,
 * IPv4-translated (SIIT), IPv4-compatible, well-known NAT64 (64:ff9b::/96) or
 * 6to4 (2002::/16). A NAT64 prefix a network chose itself cannot be recognised.
 */
export function embeddedIPv4(address: string): string | null {
  const b = ipv6Bytes(address);
  if (!b) return null;
  const v4 = (o: number) => b.slice(o, o + 4).join('.');
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(12); // ::ffff:a.b.c.d
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && zeros(10, 12)) return v4(12); // ::ffff:0:a.b.c.d (SIIT)
  if (zeros(0, 12) && !zeros(12, 16)) return v4(12); // ::a.b.c.d (deprecated)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return v4(12); // 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2); // 2002:aabb:ccdd::/48
  return null;
}

export type RefusalClass = 'reserved' | 'private' | 'not-an-address';

/** Why a resolved address may not be used for media, or null when it may. */
export function mediaEgressRefusal(address: string): RefusalClass | null {
  const family = isIP(address);
  if (family === 0) return 'not-an-address';
  if (family === 6) {
    if (reserved.check(address, 'ipv6')) return 'reserved';
    const v4 = embeddedIPv4(address);
    if (v4) return mediaEgressRefusal(v4);
  } else if (reserved.check(address, 'ipv4')) {
    return 'reserved';
  }
  if (isNeverAllowedIP(address)) return 'reserved';
  if (isPrivateIP(address)) return 'private';
  return null;
}
