import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, './package.json'), 'utf-8')) as {
  version: string;
};

const rawSha = process.env.VITE_GIT_SHA || process.env.GITHUB_SHA || '';
const gitSha = rawSha.replace(/^sha-/, '').slice(0, 7);

export default defineConfig({
  plugins: [react(), VitePWA({
    strategies: 'injectManifest',
    srcDir: 'pwa',
    filename: 'sw.ts',
    injectRegister: false,
    registerType: 'prompt',
    // Only these build outputs enter Cache Storage. No runtime caching.
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
  })],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
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
