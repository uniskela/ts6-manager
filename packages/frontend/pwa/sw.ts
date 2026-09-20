/// <reference lib="webworker" />
import { clientsClaim, setCacheNameDetails } from 'workbox-core';
import { precache, createHandlerBoundToURL, getCacheKeyForURL, matchPrecache } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { canHandleRequest, isAppNavigation } from './cache-policy';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

setCacheNameDetails({ prefix: 'ts6-manager' });
// Install/activate precaching only; deliberately do NOT register Workbox's
// permissive default precache route or any runtime caching strategies.
precache(self.__WB_MANIFEST);

registerRoute(
  ({ request, url }) => canHandleRequest(request, url, self.location.origin)
    && request.mode !== 'navigate'
    && url.search === ''
    && !!getCacheKeyForURL(url.href),
  async ({ url, request }) => (await matchPrecache(url.href)) ?? fetch(request),
);

registerRoute(
  ({ request, url }) => canHandleRequest(request, url, self.location.origin)
    && isAppNavigation(request, url),
  createHandlerBoundToURL('/index.html'),
);

// No skipWaiting during install: activation requires the user's Reload action
// (or closing all old clients). The UI warns that Reload affects open tabs.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
clientsClaim();
