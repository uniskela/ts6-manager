import { defineConfig, type IndexHtmlTransformContext, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';
import { isListenerRemoteHtml } from './vite/remote-html';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, './package.json'), 'utf-8')) as {
  version: string;
};

const rawSha = process.env.VITE_GIT_SHA || process.env.GITHUB_SHA || '';
const gitSha = rawSha.replace(/^sha-/, '').slice(0, 7);
/** Compile Playwright auth seams only for `build:e2e` / VITE_E2E_AUTH_HOOKS=true. */
const e2eAuthHooks = process.env.VITE_E2E_AUTH_HOOKS === 'true';

/** Serve /remote from remote.html in dev and preview (MPA entry lives at /remote.html). */
function remoteHtmlFallback(): Plugin {
  const rewrite = (url: string) => {
    const q = url.indexOf('?');
    const pathOnly = q === -1 ? url : url.slice(0, q);
    const query = q === -1 ? '' : url.slice(q);
    if (pathOnly === '/remote' || pathOnly === '/remote/') return `/remote.html${query}`;
    return url;
  };
  return {
    name: 'remote-html-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) req.url = rewrite(req.url);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) req.url = rewrite(req.url);
        next();
      });
    },
  };
}

/**
 * Run VitePWA only for the admin shell. Skipping transformIndexHtml for remote.html
 * prevents manifest / SW register tags at source — no post-hoc HTML string scrubbing.
 */
function adminOnlyVitePwa(options: Partial<VitePWAOptions>): Plugin[] {
  return VitePWA(options).map((plugin) => {
    const transform = plugin.transformIndexHtml;
    if (!transform) return plugin;

    const apply = typeof transform === 'function'
      ? transform
      : transform.handler.bind(transform);
    const order = typeof transform === 'function' ? undefined : transform.order;

    return {
      ...plugin,
      transformIndexHtml: {
        order,
        handler(html: string, ctx: IndexHtmlTransformContext) {
          if (isListenerRemoteHtml(ctx)) return html;
          return apply(html, ctx);
        },
      },
    };
  });
}

export default defineConfig({
  plugins: [react(), remoteHtmlFallback(), ...adminOnlyVitePwa({
    strategies: 'injectManifest',
    srcDir: 'pwa',
    filename: 'sw.ts',
    injectRegister: false,
    registerType: 'prompt',
    // Only these build outputs enter Cache Storage. No runtime caching.
    // remote.html stays off the precache list so the root worker never owns /remote.
    injectManifest: {
      globPatterns: ['index.html', 'manifest.webmanifest', 'assets/*.{js,css,woff,woff2}', 'icons/*.{png,svg}', 'favicon.svg'],
    },
    includeManifestIcons: false,
    manifest: {
      id: '/',
      name: 'TS6 Manager',
      short_name: 'TS6 Manager',
      description: 'Manage your TeamSpeak servers, clients, channels and bots.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#0b0e13',
      background_color: '#0b0e13',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
  })],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(gitSha),
    __TS6_E2E_AUTH_HOOKS__: JSON.stringify(e2eAuthHooks),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        // Keep the admin entry chunk named index-* so production PWA tests and
        // existing asset expectations stay stable under the MPA build.
        index: path.resolve(__dirname, 'index.html'),
        remote: path.resolve(__dirname, 'remote.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
