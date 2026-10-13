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

let warned = false;
function storageBlocked(error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn('Session storage is unavailable; automatic gateway sign-in is disabled.', error);
}

/** Load the current page from the network so the proxy can sign the user in. */
export function reauthenticateAtEdge(): void {
  const url = new URL(window.location.href);
  url.searchParams.set(MARKER, '1');
  window.location.replace(url.href);
}

/**
 * Take this tab's one automatic attempt. False when it was already used, or
 * when it cannot be recorded: an unrecorded attempt would reload forever
 * against a proxy that keeps redirecting.
 */
export function claimEdgeReauthAttempt(): boolean {
  try {
    if (sessionStorage.getItem(ATTEMPT_KEY) !== null) return false;
    sessionStorage.setItem(ATTEMPT_KEY, '1');
    return sessionStorage.getItem(ATTEMPT_KEY) !== null;
  } catch (error) {
    storageBlocked(error);
    return false;
  }
}

export function clearEdgeReauthAttempt(): void {
  try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (error) { storageBlocked(error); }
}
