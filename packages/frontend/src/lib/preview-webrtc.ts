/**
 * Helpers for WebUI browser-preview WebRTC (ICE hang / misconfig diagnostics).
 * Kept free of React so unit tests can exercise the SDP/host checks.
 */

/** How long to wait for ICE connected/completed before surfacing a timeout. */
export const PREVIEW_ICE_TIMEOUT_MS = 15_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when the page is served from a loopback hostname. */
export function isBrowserOnLoopback(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  if (LOOPBACK_HOSTS.has(h)) return true;
  // IPv4 loopback range 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Extract IPv4 host-candidate addresses from an SDP offer.
 * Ignores srflx/relay/prflx — NAT1To1 misconfig shows up as host=127.0.0.1.
 */
export function hostCandidateIpsFromSdp(sdp: string): string[] {
  const ips: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const trimmed = line.trim();
    // a=candidate:<foundation> <component> <proto> <prio> <ip> <port> typ host …
    const m = /^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+host\b/i.exec(trimmed);
    if (!m) continue;
    const ip = m[1];
    // Mux binds udp4 only; still accept IPv6 loopback if it appears.
    if (ip) ips.push(ip);
  }
  return ips;
}

export function isLoopbackIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (v === '::1' || v === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v);
}

/**
 * True when the offer advertises at least one host candidate and every host
 * candidate is loopback (typical WEBRTC_NAT1TO1_IP=127.0.0.1).
 */
export function offerAdvertisesLoopbackOnly(sdp: string): boolean {
  const hosts = hostCandidateIpsFromSdp(sdp);
  if (hosts.length === 0) return false;
  return hosts.every(isLoopbackIp);
}

export type PreviewIceFailureKind = 'failed' | 'timeout' | 'loopback-mismatch';

const BASE_HINT =
  'Check WEBRTC_UDP_PORT is published, WEBRTC_NAT1TO1_IP / WEBRTC_BIND_IP are an IPv4 the browser can reach (not 127.0.0.1 for a remote/reverse-proxied WebUI), and UDP is allowed through the host firewall. NGINX only proxies signaling — not WebRTC media.';

export function previewIceErrorMessage(kind: PreviewIceFailureKind): string {
  switch (kind) {
    case 'loopback-mismatch':
      return (
        'Preview cannot reach the media sidecar: the offer advertises loopback (127.0.0.1) host candidates, ' +
        'but this WebUI is not on localhost. Set WEBRTC_NAT1TO1_IP and WEBRTC_BIND_IP to a LAN/Tailscale IPv4 ' +
        'the browser can reach, and publish UDP on that address — not 127.0.0.1.'
      );
    case 'timeout':
      return `Preview connection timed out (ICE). ${BASE_HINT}`;
    case 'failed':
    default:
      return `Preview connection failed (ICE). ${BASE_HINT}`;
  }
}
