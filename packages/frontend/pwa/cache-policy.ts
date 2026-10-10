// Keep navigation explicit: unknown/backend paths must never receive app HTML.
const APP_ROUTES = new Set([
  'dashboard', 'servers', 'channels', 'clients', 'server-groups', 'channel-groups',
  'permissions', 'bans', 'tokens', 'files', 'complaints', 'messages', 'logs',
  'instance', 'music-requests', 'bots', 'media-bots', 'music-bots', 'iptv',
  'settings', 'login', 'setup', 'remote',
]);

function isAppPath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (path === '/') return true;
  const parts = path.split('/');
  if (parts.length === 2) return APP_ROUTES.has(parts[1]);
  return parts.length === 3 && parts[1] === 'bots' && parts[2].length > 0;
}

export function canHandleRequest(request: Request, url: URL, origin: string): boolean {
  return request.method === 'GET'
    && url.origin === origin
    && !request.headers.has('authorization')
    && !/^\/(?:api|ws)(?:\/|$)/i.test(url.pathname);
}

export function isAppNavigation(request: Request, url: URL): boolean {
  return request.mode === 'navigate' && isAppPath(url.pathname);
}
