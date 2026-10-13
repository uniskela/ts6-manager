// An authenticating proxy in front of the app (Cloudflare Access, oauth2-proxy,
// Authelia…) can only renew its session on a real page navigation. The service
// worker answers app navigations from its precache, so this marker asks it to
// stand aside for one load. Keep the name in sync with pwa/cache-policy.ts.
const MARKER = 'edge-auth';
const ATTEMPT_KEY = 'ts6-edge-reauth';

/** Remove the marker before the router reads the URL. */
export function stripEdgeReauthMarker(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(MARKER)) return;
  url.searchParams.delete(MARKER);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

/** Load the current page from the network so the proxy can sign the user in. */
export function reauthenticateAtEdge(): void {
  try { sessionStorage.setItem(ATTEMPT_KEY, '1'); } catch { /* Storage may be blocked. */ }
  const url = new URL(window.location.href);
  url.searchParams.set(MARKER, '1');
  window.location.replace(url.href);
}

/** True when this tab already tried and the proxy still redirects: do not loop. */
export function edgeReauthAttempted(): boolean {
  try { return sessionStorage.getItem(ATTEMPT_KEY) !== null; } catch { return false; }
}

export function clearEdgeReauthAttempt(): void {
  try { sessionStorage.removeItem(ATTEMPT_KEY); } catch { /* Storage may be blocked. */ }
}
