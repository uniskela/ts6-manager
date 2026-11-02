/** Address/port policy. Keep aligned with packages/backend/src/voice/egress/egress-policy.ts. */
import { BlockList, isIP } from 'node:net';

export const MEDIA_EGRESS_PORTS = new Set([80, 443]);
export const RADIO_EGRESS_PORTS = new Set([80, 443, 8000, 8008, 8080, 8443]);

const reserved = new BlockList();
for (const [ip, prefix] of [
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['240.0.0.0', 4],
]) reserved.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['3fff::', 20],
  ['64:ff9b:1::', 48], ['fec0::', 10],
]) reserved.addSubnet(ip, prefix, 'ipv6');

const neverAllowed = new BlockList();
for (const ip of ['169.254.169.254', '100.100.100.200']) neverAllowed.addAddress(ip, 'ipv4');
neverAllowed.addAddress('fd00:ec2::254', 'ipv6');
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4],
]) neverAllowed.addSubnet(ip, prefix, 'ipv4');
neverAllowed.addAddress('::', 'ipv6');
neverAllowed.addAddress('::1', 'ipv6');
neverAllowed.addSubnet('fe80::', 10, 'ipv6');
neverAllowed.addSubnet('ff00::', 8, 'ipv6');

const privateNets = new BlockList();
for (const [ip, prefix] of [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10],
]) privateNets.addSubnet(ip, prefix, 'ipv4');
privateNets.addSubnet('fc00::', 7, 'ipv6');

function check(list, address, family) {
  return family !== 0 && list.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

function ipv6Bytes(address) {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const tail = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    tail.push(...dotted[1].split('.').map(Number));
    text = `${text.slice(0, -dotted[1].length)}0:0`;
  }
  const [head, rest] = text.split('::');
  const words = (part) => (part ? part.split(':').filter(Boolean).map((w) => Number.parseInt(w, 16)) : []);
  const left = words(head);
  const right = words(rest);
  const fill = rest === undefined ? [] : new Array(8 - left.length - right.length).fill(0);
  const all = [...left, ...fill, ...right];
  if (all.length !== 8) return null;
  const bytes = all.flatMap((w) => [w >> 8, w & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function embeddedIPv4(address) {
  const b = ipv6Bytes(address);
  if (!b) return null;
  const v4 = (o) => b.slice(o, o + 4).join('.');
  const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(12);
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && zeros(10, 12)) return v4(12);
  if (zeros(0, 12) && !zeros(12, 16)) return v4(12);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return v4(12);
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2);
  return null;
}

export function mediaEgressRefusal(address, { permitPrivate = false } = {}) {
  const family = isIP(address);
  if (family === 0) return 'not-an-address';
  if (family === 6) {
    if (check(reserved, address, 6)) return 'reserved';
    const v4 = embeddedIPv4(address);
    if (v4) return mediaEgressRefusal(v4, { permitPrivate });
  } else if (check(reserved, address, 4)) {
    return 'reserved';
  }
  if (check(neverAllowed, address, family)) return 'reserved';
  if (!permitPrivate && check(privateNets, address, family)) return 'private';
  return null;
}

export function pinMediaAddresses(answers, opts) {
  if (answers.length === 0) return { addresses: [], reason: 'did not resolve' };
  const addresses = [];
  let poison;
  for (const address of answers) {
    const refusal = mediaEgressRefusal(address, opts);
    if (refusal) poison = `${refusal} address`;
    else addresses.push(address);
  }
  if (poison) return { addresses: [], reason: poison };
  return { addresses, reason: 'did not resolve' };
}
