import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, './package.json'), 'utf-8')) as {
  version: string;
};

const rawSha = process.env.VITE_GIT_SHA || process.env.GITHUB_SHA || '';
const gitSha = rawSha.replace(/^sha-/, '').slice(0, 7);

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

/** Keep the admin PWA manifest and SW register tags off the isolated remote entry. */
function stripRemotePwaTags(): Plugin {
  const scrub = (html: string) => html
    .replace(/<link[^>]+rel=["']manifest["'][^>]*>\s*/gi, '')
    .replace(/<script[^>]*registerSW[^>]*>[\s\S]*?<\/script>\s*/gi, '');
  return {
    name: 'strip-remote-pwa-tags',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.filename?.endsWith('remote.html') && ctx.path !== '/remote.html' && ctx.path !== '/remote') {
          return html;
        }
        return scrub(html);
      },
    },
    closeBundle() {
      const file = path.resolve(__dirname, 'dist/remote.html');
      try {
        writeFileSync(file, scrub(readFileSync(file, 'utf8')));
      } catch {
        /* no remote.html in this build */
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), remoteHtmlFallback(), VitePWA({
    strategies: 'injectManifest',
    srcDir: 'pwa',
    filename: 'sw.ts',
    injectRegister: false,
    registerType: 'prompt',
    // Only these build outputs enter Cache Storage. No runtime caching.
    // remote.html stays off the precache list so the root worker never owns /remote.
    injectManifest: {
      globPatterns: ['index.html', 'manifest.webmanifest', 'assets/*.{js,css,woff,woff2}', 'icons/*.png', 'favicon.svg'],
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
  }), stripRemotePwaTags()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
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
