import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');

const FORBIDDEN = [
  'fonts.googleapis',
  'auth.store',
  'useAuthStore',
  'AppLayout',
  'PwaStatus',
  'safe-ui',
  'edge-reauth',
  'QueryClientProvider',
];

function collectRemoteAssets(html: string): string[] {
  const files = new Set<string>();
  for (const match of html.matchAll(/\b(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)) {
    files.add(match[1].slice(1));
  }
  const queue = [...files];
  while (queue.length > 0) {
    const relative = queue.pop()!;
    const absolute = path.join(dist, relative);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, 'utf8');
    const dir = path.posix.dirname(relative);
    for (const match of text.matchAll(/["'](\.?\.?\/[^"']+\.(?:js|css))["']/g)) {
      const resolved = path.posix.normalize(path.posix.join(dir, match[1]));
      if (!resolved.startsWith('assets/') || files.has(resolved)) continue;
      if (!existsSync(path.join(dist, resolved))) continue;
      files.add(resolved);
      queue.push(resolved);
    }
  }
  return [...files];
}

describe('listener remote bundle isolation', () => {
  it('keeps the remote entry free of admin auth, PWA, and Google Fonts', () => {
    assert.equal(existsSync(path.join(dist, 'remote.html')), true, 'build dist/remote.html first');
    const html = readFileSync(path.join(dist, 'remote.html'), 'utf8');
    assert.match(html, /<title>Listener remote<\/title>/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
    assert.doesNotMatch(html, /fonts\.googleapis/);
    assert.doesNotMatch(html, /rel=["']manifest["']/);

    const assets = collectRemoteAssets(html);
    assert.ok(assets.some((file) => file.endsWith('.js')), 'remote entry must load JS');
    assert.ok(assets.some((file) => file.endsWith('.css')), 'remote entry must load CSS');

    for (const relative of assets) {
      const text = readFileSync(path.join(dist, relative), 'utf8');
      for (const needle of FORBIDDEN) {
        assert.equal(text.includes(needle), false, `${relative} must not contain ${needle}`);
      }
    }

    const indexHtml = readFileSync(path.join(dist, 'index.html'), 'utf8');
    assert.notEqual(indexHtml, html);
    assert.match(indexHtml, /rel=["']manifest["']/, 'admin shell still receives the PWA manifest');
    assert.match(indexHtml, /\/assets\/index-[^"]+\.js/, 'admin entry keeps the index-* chunk name');
    assert.equal(readdirSync(dist).includes('remote.html'), true);
  });
});
