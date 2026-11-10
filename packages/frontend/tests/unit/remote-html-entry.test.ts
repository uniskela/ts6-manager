import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isListenerRemoteHtml } from '../../vite/remote-html';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('listener remote HTML entry gating', () => {
  it('recognises the isolated remote entry paths', () => {
    assert.equal(isListenerRemoteHtml({ filename: '/app/remote.html' }), true);
    assert.equal(isListenerRemoteHtml({ path: '/remote.html' }), true);
    assert.equal(isListenerRemoteHtml({ path: '/remote' }), true);
    assert.equal(isListenerRemoteHtml({ path: '/remote/' }), true);
    assert.equal(isListenerRemoteHtml({ filename: '/app/index.html', path: '/' }), false);
    assert.equal(isListenerRemoteHtml({ path: '/login' }), false);
  });

  it('keeps admin PWA injection gated at source instead of HTML-string scrubbing', () => {
    const viteConfig = readFileSync(path.join(frontendRoot, 'vite.config.ts'), 'utf8');
    assert.match(viteConfig, /adminOnlyVitePwa/);
    assert.match(viteConfig, /isListenerRemoteHtml/);
    assert.doesNotMatch(viteConfig, /stripRemotePwaTags/);
    assert.doesNotMatch(viteConfig, /\.replace\(\/<link/);
    assert.doesNotMatch(viteConfig, /\.replace\(\/<script/);
    assert.doesNotMatch(viteConfig, /registerSW\[\^>/);
  });
});
