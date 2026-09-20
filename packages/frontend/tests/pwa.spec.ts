import { test, expect, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { canHandleRequest, isAppNavigation } from '../pwa/cache-policy';

const routes = ['/dashboard', '/channels', '/clients', '/permissions', '/server-groups', '/channel-groups', '/music-bots', '/bots', '/bots/1', '/files', '/settings', '/login', '/setup'];
const privatePaths = ['/api', '/api/health', '/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/auth/me', '/api/setup/status', '/api/servers/1/clients', '/api/servers/1/files', '/api/servers/1/tokens', '/api/servers/1/bans', '/api/music-bots', '/api/bots/1/logs', '/ws', '/ws/live'];

async function controlled(page: Page) {
  await page.goto('/login');
  await expect(page.getByLabel('Username')).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect(page.getByRole('button', { name: 'Reload all tabs' })).toHaveCount(0);
}

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('request policy denies private, cross-origin, authenticated and mutating requests', () => {
  const origin = 'https://example.test';
  for (const path of privatePaths) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const req = new Request(origin + path, { method });
      expect(canHandleRequest(req, new URL(req.url), origin)).toBe(false);
    }
  }
  for (const req of [new Request('https://cdn.example.test/assets/app.js'), new Request(origin + '/assets/app.js', { headers: { Authorization: 'Bearer test' } }), new Request(origin + '/settings', { method: 'POST' })]) {
    expect(canHandleRequest(req, new URL(req.url), origin)).toBe(false);
  }
  for (const path of routes) expect(isAppNavigation({ mode: 'navigate' } as Request, new URL(path, origin))).toBe(true);
  for (const path of ['/api/auth', '/ws', '/widget/private-token', '/unknown', '/settings-extra']) expect(isAppNavigation({ mode: 'navigate' } as Request, new URL(path, origin))).toBe(false);
});

test('production manifest and icons meet installability requirements', async ({ page, request }) => {
  await controlled(page);
  const manifestUrl = await page.locator('link[rel=manifest]').getAttribute('href');
  const manifest = await (await request.get(manifestUrl!)).json();
  expect(manifest).toMatchObject({ name: 'TS6 Manager', id: '/', start_url: '/', scope: '/', display: 'standalone' });
  for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBe(true);
    const png = await response.body();
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
  }
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  expect((await cdp.send('Page.getAppManifest')).errors).toEqual([]);
  expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
});

test('real worker caches only public build output; private traffic stays live', async ({ page }) => {
  await controlled(page);
  for (const path of privatePaths) {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === path);
    await page.evaluate(async path => { await fetch(path, { headers: { Authorization: 'Bearer test-secret' } }); }, path);
    expect((await response).fromServiceWorker()).toBe(false);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = page.waitForResponse(r => r.request().method() === method);
    await page.evaluate(async method => { await fetch('/api/admin-action', { method, body: 'private-action' }); }, method);
    expect((await response).fromServiceWorker()).toBe(false);
  }
  expect(await page.evaluate(() => new Promise(resolve => {
    const socket = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
    socket.onmessage = event => { resolve(event.data); socket.close(); };
  }))).toBe('live-test-message');
  const cached = await page.evaluate(async () => {
    const result: Array<{ path: string; body: string }> = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) result.push({ path: new URL(req.url).pathname, body: await (await cache.match(req))!.text() });
    }
    return result;
  });
  expect(cached.length).toBeGreaterThan(10);
  for (const item of cached) {
    expect(item.path).toMatch(/^\/(index\.html|manifest\.webmanifest|favicon\.svg|icons\/[^/]+\.png|assets\/[^/]+\.(js|css|woff2?))$/);
    expect(item.body).not.toContain('test-only-sensitive-response');
    expect(item.body).not.toContain('test-secret');
    expect(item.body).not.toContain('private-action');
  }
  // Also inspect emitted build artifacts rather than trusting plugin defaults.
  const worker = readFileSync('dist/sw.js', 'utf8');
  expect(worker).not.toContain('staleWhileRevalidate');
  expect(readdirSync('dist').some(file => file.endsWith('.map'))).toBe(false);
});

test('offline shell supports deep links without swallowing APIs or replaying mutations', async ({ page, context, request }) => {
  await controlled(page);
  await context.setOffline(true);
  await expect(page.getByRole('status')).toContainText('Server unavailable');
  await page.getByLabel('Username').fill('offline-test');
  await page.getByLabel('Password', { exact: true }).fill('not-a-real-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeEnabled();
  for (const path of privatePaths) {
    expect(await page.evaluate(async path => fetch(path).then(() => 'unexpected response', () => 'network failure'), path)).toBe('network failure');
  }
  for (const path of routes) {
    const response = await page.goto(path);
    expect(response?.fromServiceWorker(), path).toBe(true);
    expect(await response?.text()).toContain('<div id="root">');
  }
  await context.setOffline(false);
  await page.goto('/login');
  expect((await (await request.get('/__test/state')).json()).mutations).toBe(0);
});

test('backend outage is visible even when the browser is online and clears on recovery', async ({ page, request }) => {
  await controlled(page);
  await request.post('/__test/unavailable?on');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('status')).toContainText('Displayed data may be outdated');
  await request.post('/__test/unavailable');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('private navigation stays network-only and missing static files are not HTML', async ({ page, request }) => {
  await controlled(page);
  for (const path of ['/api/auth/me', '/ws']) {
    const response = await page.goto(path);
    expect(response?.fromServiceWorker()).toBe(false);
    expect(response?.headers()['content-type']).toContain('application/json');
  }
  for (const path of ['/assets/missing.js', '/icons/missing.png']) {
    expect((await request.get(path)).status()).toBe(404);
  }
});

test('a new worker waits without discarding edits, then updates all tabs intentionally', async ({ page, context, request }) => {
  await controlled(page);
  const other = await context.newPage();
  await controlled(other);
  await page.getByLabel('Username').fill('unsaved-edit');
  await other.getByLabel('Username').fill('other-unsaved-edit');
  await request.post('/__test/update');
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await expect(page.getByRole('button', { name: 'Reload all tabs' })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Reload all tabs' })).toBeVisible();
  await expect(page.getByLabel('Username')).toHaveValue('unsaved-edit');
  await expect(other.getByLabel('Username')).toHaveValue('other-unsaved-edit');
  await page.getByRole('button', { name: 'Reload all tabs' }).click();
  await expect(page.getByLabel('Username')).toHaveValue('');
  await expect(other.getByLabel('Username')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Reload all tabs' })).toHaveCount(0);
  await other.close();
});

for (const [width, height] of [[390, 844], [430, 932], [768, 1024], [844, 390], [1440, 900]]) {
  test(`login fits ${width}x${height} and permits zoom`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await controlled(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).not.toMatch(/user-scalable=no|maximum-scale/);
    await page.getByRole('button', { name: 'Sign In' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeInViewport();
  });
}
