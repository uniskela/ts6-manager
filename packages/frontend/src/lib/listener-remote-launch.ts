const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Read `#token=` and drop it. Query strings are never a token channel. */
export function takeHashToken(hash: string): { token: string | null; nextHash: string; removed: boolean } {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(body);
  if (!params.has('token')) return { token: null, nextHash: hash, removed: false };
  const value = params.get('token');
  params.delete('token');
  const rest = params.toString();
  const token = value && TOKEN.test(value) ? value : null;
  return { token, nextHash: rest ? `#${rest}` : '', removed: true };
}

let captured = false;
let launchToken: string | null = null;
let installed = false;

export function remoteLaunchToken(): string | null {
  return launchToken;
}

export function captureRemoteLaunchToken(
  loc: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
  replace: (url: string) => void = (url) => window.history.replaceState(null, '', url),
): string | null {
  if (captured) return launchToken;
  captured = true;
  if (!/^\/remote\/?$/.test(loc.pathname)) return null;
  const taken = takeHashToken(loc.hash);
  if (taken.removed) replace(`${loc.pathname}${loc.search}${taken.nextHash}`);
  launchToken = taken.token;
  return launchToken;
}

/** Strip the fragment before React paints. A later `#token=` in this document exchanges again. */
export function installRemoteTokenCapture(): void {
  captureRemoteLaunchToken();
  if (installed) return;
  installed = true;
  window.addEventListener('hashchange', () => {
    captured = false;
    if (captureRemoteLaunchToken()) window.dispatchEvent(new Event('ts6-remote-token'));
  });
}

export function resetRemoteLaunchForTests(): void {
  captured = false;
  launchToken = null;
  installed = false;
}
