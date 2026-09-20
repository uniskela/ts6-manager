# PWA maintenance and validation

The frontend uses `vite-plugin-pwa` in `injectManifest` mode. `packages/frontend/pwa/sw.ts` owns routing; plugin-generated runtime cache defaults are not used. Registration happens only in production builds on secure origins. Both stock nginx configurations support root-path hosting.

## Cache boundary

Only `index.html`, `manifest.webmanifest`, build-produced `assets/*.{js,css,woff,woff2}`, `icons/*.png`, and `favicon.svg` are revisioned and precached. The build output is public and identical for every user. Do not inject user/session data into these files or expand the glob to backend files, downloads, source maps, media, or arbitrary JSON.

The worker serves exact precache entries for same-origin GET requests without query strings or Authorization headers. Navigation uses the static `index.html` only for the explicit application-route allow-list. It never stores a deep-link URL, query string, or a network navigation response. Login/setup **documents** are the same public shell; login/setup **API responses** remain network-only. Public widget URLs and unknown routes are excluded from worker navigation fallback.

**`/api/**`, authentication/session traffic, WebSocket/live TeamSpeak state and mutations are never intentionally cached by the service worker.** Requests outside the static/navigation allow-lists pass through without `respondWith`. There is no runtime caching, background sync, offline request queue, external font/media cache, or catch-all offline response. React Query mutations use `networkMode: 'always'` and no retry, so offline actions fail instead of being paused for replay. Query data remains in memory only; the existing authentication storage model is unchanged.

When adding an app route, review `pwa/cache-policy.ts` and the routing tests. Review the **emitted** `dist/sw.js` after changes: precache contents must contain only the allowed static files. Do not put secrets or personalized responses behind static paths.

## Activation and deployment

The worker does not skip waiting at install time. A visible update notice sends `SKIP_WAITING` only after the user's **Reload all tabs** action. `clientsClaim` and `controllerchange` then reload already-controlled windows together; first installation claims without reloading. This avoids leaving open tabs using old lazy chunks after Workbox removes obsolete precache entries. The notice explicitly asks users to save work in all windows. Closing every old client allows the browser's normal activation lifecycle.

Registration uses `updateViaCache: 'none'`. Both nginx configurations send `no-cache` for `sw.js`, `index.html`, and the manifest; hashed assets are immutable. Missing worker/assets/icons return 404 rather than app HTML. Keep these rules at any outer reverse proxy/CDN, too. Deploy the frontend and backend together and preserve API compatibility while users finish work before applying an update. A user can defer an update; forcing activation would risk losing administrative edits.

If worker registration, installation, or storage fails, ordinary browser use continues. Keep `/sw.js` stable across releases. Do not simply delete the worker on rollback: deploy the previous frontend with its worker so clients receive a normal update. An emergency removal needs an explicitly designed cleanup worker.

## Validation

After building, `pnpm --filter @ts6/frontend test` runs Playwright against production output, including the real emitted worker. Install Chromium with `pnpm --filter @ts6/frontend exec playwright install chromium` first. These tests use generic synthetic API responses to isolate worker security and lifecycle behavior; they are not TeamSpeak integration tests.

Also test both actual nginx configurations, and run the real backend with its generic Demo TeamSpeak Server for dashboard, channels, clients, groups, permissions, files, music bots, bot flows, and Settings QA. Verify login, refresh after expiry, logout, expired sessions, backend loss/recovery, and cache contents. Never use real credentials or private fixtures in committed test data.

Physical-device release checklist (browser emulation cannot certify OS installation):

- iPhone/iPad Safari: Add to Home Screen, launcher icon, status bar, notch/Home indicator, portrait/landscape, keyboard with login/setup/dialogs/editor, app resume after token expiry.
- Android Chromium: install prompt/menu, adaptive icon safe zone, standalone launch and deep links, keyboard, update across open windows.
- Desktop: install/uninstall/reinstall, keyboard navigation, ordinary-tab sidebar/dialog behavior.

The icon source is the existing teal TS monogram, expressed as paths in `public/favicon.svg`. Regenerate the four PNGs with `node packages/frontend/scripts/generate-icons.mjs` from the repository root (uses the backend's existing SVG renderer). The maskable image has an opaque full canvas; its meaningful TS strokes fit within the central 80%-diameter safe circle.
