import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { canHandleRequest, isAppNavigation } from '../pwa/cache-policy';

const routes = ['/dashboard', '/channels', '/clients', '/permissions', '/server-groups', '/channel-groups', '/music-bots', '/bots', '/bots/1', '/files', '/settings', '/login', '/setup'];
const privatePaths = ['/api', '/api/health', '/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/auth/me', '/api/setup/status', '/api/servers/1/clients', '/api/servers/1/files', '/api/servers/1/tokens', '/api/servers/1/bans', '/api/music-bots', '/api/bots/1/logs', '/ws', '/ws/live'];
const baseThemes = ['light', 'dark', 'black'] as const;
const accents = ['cyan', 'violet', 'red', 'blue', 'emerald', 'amber'] as const;

type Rgb = [number, number, number];

function parseRgb(value: string): Rgb {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Expected an RGB colour, received ${value}`);
  return channels as Rgb;
}

function contrastRatio(left: string, right: string) {
  const luminance = (rgb: Rgb) => {
    const channels = rgb.map(value => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const a = luminance(parseRgb(left));
  const b = luminance(parseRgb(right));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function controlled(page: Page) {
  await page.goto('/login');
  await expect(page.getByLabel('Username')).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect(page.getByRole('button', { name: 'Reload all tabs' })).toHaveCount(0);
}

async function signInAsAdmin(page: Page, request: APIRequestContext) {
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
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

test('canonical brand mark is shared by product surfaces', async ({ page, request }) => {
  const favicon = await (await request.get('/favicon.svg')).text();
  expect(favicon).toContain('viewBox="0 0 512 512"');
  expect(favicon).toContain('currentColor');
  expect(favicon).not.toMatch(/<text|>TS</i);

  await controlled(page);
  await expect(page.getByRole('heading', { name: 'TS6 Manager' })).toBeVisible();
  await expect(page.locator('[data-brand-mark]')).toHaveCount(1);

  await request.post('/__test/setup?on');
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'TS6 Manager' })).toBeVisible();
  await expect(page.locator('[data-brand-mark]')).toHaveCount(1);
  await request.post('/__test/setup');

  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('brand-test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');

  const brandLink = page.locator('a[aria-label="TS6 Manager dashboard"]');
  await expect(brandLink).toBeVisible();
  await expect(brandLink).toHaveAttribute('href', '/dashboard');
  await expect(brandLink.locator('[data-brand-mark]')).toHaveCount(1);

  await page.goto('/settings');
  await page.getByRole('tab', { name: 'About' }).click();
  await expect(page.getByRole('heading', { name: 'TS6 Manager' })).toBeVisible();
  await expect(page.locator('[data-brand-mark]')).toHaveCount(2);
});

test('appearance bootstrap applies a stored black violet preference before first paint', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: { sidebarCollapsed: false, baseTheme: 'black', accent: 'violet' },
      version: 1,
    }));
    requestAnimationFrame(() => {
      (window as any).__firstAppearance = {
        theme: document.documentElement.dataset.theme,
        accent: document.documentElement.dataset.accent,
        dark: document.documentElement.classList.contains('dark'),
        black: document.documentElement.classList.contains('black'),
      };
    });
  });

  await page.goto('/login');
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__firstAppearance)).toEqual({
    theme: 'black',
    accent: 'violet',
    dark: true,
    black: true,
  });
});

test('appearance migrates old and invalid stored preferences to safe values', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Username')).toBeVisible();

  await page.evaluate(() => localStorage.setItem('ts6-ui', JSON.stringify({
    state: { sidebarCollapsed: true, theme: 'light' },
    version: 0,
  })));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'cyan');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!).state)).toMatchObject({
    sidebarCollapsed: true,
    baseTheme: 'light',
    accent: 'cyan',
  });

  await page.evaluate(() => localStorage.setItem('ts6-ui', JSON.stringify({
    state: { sidebarCollapsed: false, baseTheme: 'sepia', accent: 'pink' },
    version: 1,
  })));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'cyan');

  await page.evaluate(() => localStorage.setItem('ts6-ui', '{not-json'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'cyan');
});

test('appearance combinations preserve neutral and semantic tokens with visible focus', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Username')).toBeVisible();

  for (const baseTheme of baseThemes) {
    let neutralBaseline: Record<string, string> | undefined;
    let semanticBaseline: Record<string, string> | undefined;

    for (const accent of accents) {
      await page.evaluate(({ baseTheme, accent }) => localStorage.setItem('ts6-ui', JSON.stringify({
        state: { sidebarCollapsed: false, baseTheme, accent },
        version: 1,
      })), { baseTheme, accent });
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', baseTheme);
      await expect(page.locator('html')).toHaveAttribute('data-accent', accent);
      await page.getByLabel('Username').focus();

      const colours = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const probe = document.createElement('span');
        probe.style.cssText = [
          'position:fixed',
          'pointer-events:none',
          'color:hsl(var(--primary))',
          'background-color:hsl(var(--primary-foreground))',
          'border-color:hsl(var(--ring))',
        ].join(';');
        document.body.append(probe);
        const computed = getComputedStyle(probe);
        const result = {
          background: getComputedStyle(document.body).backgroundColor,
          primary: computed.color,
          primaryForeground: computed.backgroundColor,
          ring: computed.borderColor,
          focusShadow: getComputedStyle(document.querySelector<HTMLInputElement>('#username')!).boxShadow,
          mark: getComputedStyle(document.querySelector<HTMLElement>('[data-brand-mark]')!).backgroundColor,
          neutral: Object.fromEntries(['--background', '--card', '--secondary', '--muted', '--border', '--accent'].map(name => [name, root.getPropertyValue(name).trim()])),
          semantic: Object.fromEntries(['--destructive', '--success', '--warning'].map(name => [name, root.getPropertyValue(name).trim()])),
        };
        probe.remove();
        return result;
      });

      expect(contrastRatio(colours.primary, colours.primaryForeground), `${baseTheme}/${accent} primary contrast`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colours.ring, colours.background), `${baseTheme}/${accent} focus-ring contrast`).toBeGreaterThanOrEqual(3);
      expect(colours.focusShadow, `${baseTheme}/${accent} focused input`).not.toBe('none');
      expect(colours.mark, `${baseTheme}/${accent} BrandMark inheritance`).toBe(colours.primary);

      neutralBaseline ??= colours.neutral;
      semanticBaseline ??= colours.semantic;
      expect(colours.neutral, `${baseTheme}/${accent} neutral tokens`).toEqual(neutralBaseline);
      expect(colours.semantic, `${baseTheme}/${accent} semantic tokens`).toEqual(semanticBaseline);
      expect(colours.semantic['--destructive']).not.toBe('');
      expect(colours.semantic['--success']).not.toBe('');
      expect(colours.semantic['--warning']).not.toBe('');
      if (accent === 'emerald') expect(colours.semantic['--success']).not.toBe(await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--primary').trim()));
      if (accent === 'amber') expect(colours.semantic['--warning']).not.toBe(await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--primary').trim()));
    }
  }
});

test('settings sections are URL-backed and restored by browser history', async ({ page, context, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=appearance');
  await expect(page.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('data-state', 'active');
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();

  await page.getByRole('tab', { name: 'About' }).click();
  await expect(page).toHaveURL('/settings?tab=about');
  await expect(page.getByRole('heading', { name: 'TS6 Manager' })).toBeVisible();
  await page.getByRole('tab', { name: 'Account' }).click();
  await expect(page).toHaveURL('/settings?tab=account');

  await page.goBack();
  await expect(page).toHaveURL('/settings?tab=about');
  await expect(page.getByRole('tab', { name: 'About' })).toHaveAttribute('data-state', 'active');
  await page.goBack();
  await expect(page).toHaveURL('/settings?tab=appearance');
  await expect(page.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('data-state', 'active');

  const copiedLink = await context.newPage();
  await copiedLink.goto('/settings?tab=about');
  await expect(copiedLink.getByRole('tab', { name: 'About' })).toHaveAttribute('data-state', 'active');
  await expect(copiedLink.getByRole('heading', { name: 'TS6 Manager' })).toBeVisible();
  await copiedLink.close();
});

test('settings appearance controls persist and remain contained on mobile', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=appearance');

  await page.getByRole('button', { name: 'Black base theme' }).click();
  await page.getByRole('button', { name: 'Red accent' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'red');
  await expect(page.getByRole('button', { name: 'Black base theme' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Red accent' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.reload();
  await expect(page.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('data-state', 'active');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'red');
  await expect(page.getByRole('button', { name: 'Black base theme' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Red accent' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('settings connections wizard deep link remains supported', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=connections&wizard=1');
  await expect(page.getByRole('tab', { name: 'Connections' })).toHaveAttribute('data-state', 'active');
  await expect(page.getByRole('heading', { name: 'Connection setup wizard' })).toBeVisible();
  await expect(page).toHaveURL('/settings?tab=connections');
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
