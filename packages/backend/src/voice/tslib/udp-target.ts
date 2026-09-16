import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type DnsLookupFn = (
  hostname: string,
  options: { family: 4 },
) => Promise<{ address: string }>;

/**
 * Resolve the UDP destination once before a TeamSpeak voice connection starts.
 *
 * Passing a hostname directly to dgram.send() makes Node resolve it for every
 * packet. Voice playback sends packets roughly every 20 ms, so keeping the
 * resolved IPv4 target avoids hammering DNS during normal playback.
 */
export async function resolveUdpTarget(
  host: string,
  lookup: DnsLookupFn = dnsLookup as DnsLookupFn,
): Promise<string> {
  const target = host.trim();
  if (isIP(target) === 4) return target;

  const { address } = await lookup(target, { family: 4 });
  return address;
}
