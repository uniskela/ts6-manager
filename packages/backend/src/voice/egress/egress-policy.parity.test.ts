import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { test } from 'node:test';
import { MEDIA_EGRESS_PORTS, RADIO_EGRESS_PORTS, mediaEgressRefusal, pinMediaAddresses } from './egress-policy.js';

/**
 * The isolated media fetcher (services/media-fetcher/policy.mjs) keeps its own
 * copy of this address policy, with the ranges in reserved-networks.json. The
 * two must refuse exactly the same addresses. This test compares them so a
 * range added to one side only fails CI instead of drifting silently.
 */
const fetcherDir = new URL('../../../../../services/media-fetcher/', import.meta.url);
const fetcherPolicyUrl = new URL('policy.mjs', fetcherDir).href;
const fetcher = await import(fetcherPolicyUrl) as {
  MEDIA_EGRESS_PORTS: Set<number>;
  RADIO_EGRESS_PORTS: Set<number>;
  mediaEgressRefusal(address: string, opts?: { permitPrivate?: boolean }): string | null;
  pinMediaAddresses(answers: string[], opts?: { permitPrivate?: boolean }): { addresses: string[]; reason: string };
};
const networks = JSON.parse(readFileSync(new URL('reserved-networks.json', fetcherDir), 'utf8')) as Record<string, unknown[]>;

/**
 * The backend's ranges are module-private, so read their literals from source:
 * every `['address', prefix]` tuple and every quoted address. This lets a range
 * that exists only on the backend side reach the corpus too.
 */
function backendLiterals(): { subnets: Array<[string, number]>; addresses: string[] } {
  const sources = [
    readFileSync(new URL('./egress-policy.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../../utils/url-validator.ts', import.meta.url), 'utf8'),
  ].join('\n');
  const subnets: Array<[string, number]> = [];
  for (const m of sources.matchAll(/\[\s*'([0-9a-fA-F.:]+)'\s*,\s*(\d+)\s*\]/g)) {
    if (isIP(m[1])) subnets.push([m[1], Number(m[2])]);
  }
  for (const m of sources.matchAll(/addSubnet\(\s*'([0-9a-fA-F.:]+)'\s*,\s*(\d+)/g)) {
    if (isIP(m[1])) subnets.push([m[1], Number(m[2])]);
  }
  const addresses = [...sources.matchAll(/'([0-9a-fA-F.:]+)'/g)].map((m) => m[1]).filter((ip) => isIP(ip));
  return { subnets, addresses };
}
const backend = backendLiterals();

const V4_MAX = (1n << 32n) - 1n;
const V6_MAX = (1n << 128n) - 1n;

function v4ToBig(ip: string): bigint {
  return ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function bigToV4(n: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((n >> shift) & 0xffn)).join('.');
}

function v6ToBig(ip: string): bigint {
  const [head, tail] = ip.split('::');
  const words = (part: string | undefined) => (part ? part.split(':').filter(Boolean) : []);
  const left = words(head);
  const right = words(tail);
  const fill = tail === undefined ? [] : new Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].reduce((acc, w) => (acc << 16n) | BigInt(Number.parseInt(w, 16)), 0n);
}

function bigToV6(n: bigint): string {
  const words: string[] = [];
  for (let i = 7; i >= 0; i--) words.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  return words.join(':');
}

/** First, last, and the neighbours just outside a range. */
function edges(start: bigint, prefix: number, bits: number, max: bigint): bigint[] {
  const size = 1n << BigInt(bits - prefix);
  const first = start & ~(size - 1n) & max;
  const last = first + size - 1n;
  return [first, last, first - 1n, last + 1n, first + size / 2n].filter((n) => n >= 0n && n <= max);
}

function corpus(): string[] {
  const out = new Set<string>();
  const addV4 = (n: bigint) => out.add(bigToV4(n));
  const addV6 = (n: bigint) => out.add(bigToV6(n));

  // Every range and single address the fetcher lists, with its neighbours.
  for (const [key, entries] of Object.entries(networks)) {
    const v6 = key.includes('V6');
    for (const entry of entries) {
      if (Array.isArray(entry)) {
        const [ip, prefix] = entry as [string, number];
        for (const n of edges(v6 ? v6ToBig(ip) : v4ToBig(ip), prefix, v6 ? 128 : 32, v6 ? V6_MAX : V4_MAX)) {
          if (v6) addV6(n); else addV4(n);
        }
      } else {
        const ip = entry as string;
        const n = v6 ? v6ToBig(ip) : v4ToBig(ip);
        for (const m of [n - 1n, n, n + 1n]) {
          if (m < 0n) continue;
          if (v6) addV6(m); else addV4(m);
        }
      }
    }
  }

  for (const [ip, prefix] of backend.subnets) {
    const v6 = isIP(ip) === 6;
    for (const n of edges(v6 ? v6ToBig(ip) : v4ToBig(ip), prefix, v6 ? 128 : 32, v6 ? V6_MAX : V4_MAX)) {
      if (v6) addV6(n); else addV4(n);
    }
  }
  for (const ip of backend.addresses) {
    const v6 = isIP(ip) === 6;
    const n = v6 ? v6ToBig(ip) : v4ToBig(ip);
    for (const m of [n - 1n, n, n + 1n]) {
      if (m < 0n || m > (v6 ? V6_MAX : V4_MAX)) continue;
      if (v6) addV6(m); else addV4(m);
    }
  }

  // Both ends of every IPv4 /16, so a range present on only one side is likely to land on a sample.
  for (let hi = 0n; hi < 65_536n; hi++) {
    addV4(hi << 16n);
    addV4((hi << 16n) | 0xffffn);
  }

  // Deterministic spread over the rest of the IPv4 space.
  let seed = 0x2545f491n;
  for (let i = 0; i < 20_000; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    addV4(seed >> 32n);
  }

  // IPv6 forms that embed an IPv4 address are judged by that address.
  const embedded = ['8.8.8.8', '10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.0.1', '1.1.1.1', '0.0.0.0'];
  for (const v4 of embedded) {
    const n = v4ToBig(v4);
    const hex = `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
    for (const form of [
      `::ffff:${v4}`, `::ffff:${hex}`, `::ffff:0:${v4}`, `::${v4}`,
      `64:ff9b::${v4}`, `64:ff9b::${hex}`, `2002:${hex}::1`, `64:ff9b:1::${hex}`,
    ]) out.add(form);
  }

  for (const literal of [
    '::', '::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', 'fd00:ec2::254', 'fc00::1', 'fdff::1',
    '2001:db8::1', '2001:4860:4860::8888', '2606:4700:4700::1111', '3fff::1', '100::1', 'fec0::1',
    '', 'example.com', '1.2.3', '256.0.0.1', '::g', '[::1]', '01.2.3.4',
  ]) out.add(literal);
  return [...out];
}

test('the backend range literals were found', () => {
  // A format change in the backend sources must fail here, not shrink the corpus quietly.
  assert.ok(backend.subnets.length >= 20, `found ${backend.subnets.length} backend subnets`);
  assert.ok(backend.addresses.includes('169.254.169.254'));
  assert.ok(backend.addresses.includes('::1'));
});

test('fetcher egress ports match the backend', () => {
  assert.deepEqual([...fetcher.MEDIA_EGRESS_PORTS].sort((a, b) => a - b), [...MEDIA_EGRESS_PORTS].sort((a, b) => a - b));
  assert.deepEqual([...fetcher.RADIO_EGRESS_PORTS].sort((a, b) => a - b), [...RADIO_EGRESS_PORTS].sort((a, b) => a - b));
});

test('fetcher and backend refuse exactly the same addresses', () => {
  const addresses = corpus();
  const mismatches: string[] = [];
  const classes = new Map<string, number>();
  for (const address of addresses) {
    const backend = mediaEgressRefusal(address);
    const isolated = fetcher.mediaEgressRefusal(address);
    classes.set(String(backend), (classes.get(String(backend)) ?? 0) + 1);
    if (backend !== isolated) mismatches.push(`${address}: backend=${backend} fetcher=${isolated}`);
  }
  assert.deepEqual(mismatches.slice(0, 20), [], `${mismatches.length} differing addresses`);
  // The corpus must exercise every outcome, or the comparison proves little.
  for (const outcome of ['null', 'reserved', 'private', 'not-an-address']) {
    assert.ok((classes.get(outcome) ?? 0) > 0, `corpus has no ${outcome} sample`);
  }
});

test('fetcher and backend pin DNS answers the same way', () => {
  for (const answers of [
    [],
    ['8.8.8.8'],
    ['8.8.8.8', '1.1.1.1'],
    ['8.8.8.8', '10.0.0.1'],
    ['192.0.2.1', '8.8.8.8'],
    ['::ffff:127.0.0.1'],
    ['2606:4700:4700::1111', 'fe80::1'],
  ]) {
    assert.deepEqual(fetcher.pinMediaAddresses(answers), pinMediaAddresses(answers), JSON.stringify(answers));
  }
});
