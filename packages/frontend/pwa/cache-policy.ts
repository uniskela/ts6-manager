// Keep navigation explicit: unknown/backend paths must never receive app HTML.
const appRoute = /^\/(?:dashboard|servers|channels|clients|server-groups|channel-groups|permissions|bans|tokens|files|complaints|messages|logs|instance|music-requests|bots(?:\/[^/]+)?|music-bots|iptv|settings|login|setup)?\/?$/;

export function canHandleRequest(request: Request, url: URL, origin: string): boolean {
  return request.method === 'GET'
    && url.origin === origin
    && !request.headers.has('authorization')
    && !/^\/(?:api|ws)(?:\/|$)/i.test(url.pathname);
}

export function isAppNavigation(request: Request, url: URL): boolean {
  return request.mode === 'navigate' && appRoute.test(url.pathname);
}
