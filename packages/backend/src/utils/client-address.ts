import { isIPv4, isIPv6 } from 'node:net';
import type { Request } from 'express';

function ipv4Bytes(address: string): number[] | null {
  if (!isIPv4(address)) return null;
  return address.split('.').map(part => Number(part));
}

function ipv6Bytes(address: string): number[] | null {
  const zone = address.indexOf('%');
  const value = zone === -1 ? address : address.slice(0, zone);
  if (!isIPv6(value)) return null;
  const [head, tail] = value.includes('::') ? value.split('::') : [value, undefined];
  const parts = (text: string): number[] => {
    if (!text) return [];
    const groups: number[] = [];
    for (const group of text.split(':')) {
      const v4 = ipv4Bytes(group);
      if (v4) groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      else groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const first = parts(head);
  const last = tail === undefined ? [] : parts(tail);
  const groups = [...first, ...new Array<number>(8 - first.length - last.length).fill(0), ...last];
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  return groups.flatMap(group => [group >> 8, group & 0xff]);
}

/**
 * Rate-limit key for one client address: an IPv4 address on its own, or the
 * /64 network of an IPv6 address, since one host usually controls a whole /64.
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) counts as the IPv4 address. Different
 * spellings of the same address give the same key. Returns null for anything
 * that is not an IP address.
 */
export function addressRateKey(address: string | undefined): string | null {
  if (typeof address !== 'string') return null;
  const v4 = ipv4Bytes(address);
  if (v4) return `ipv4:${v4.join('.')}`;
  const v6 = ipv6Bytes(address);
  if (!v6) return null;
  if (v6.slice(0, 10).every(byte => byte === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    return `ipv4:${v6.slice(12).join('.')}`;
  }
  return `ipv6:${v6.slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('')}/64`;
}

/**
 * The client's rate-limit key. `req.ip` honours TRUST_PROXY; when it is not a
 * valid IP address (for example a forwarded header holding arbitrary text), the
 * connecting peer's address is used instead.
 */
export function clientRateKey(req: Request): string {
  return addressRateKey(req.ip) ?? addressRateKey(req.socket?.remoteAddress) ?? 'unknown';
}
