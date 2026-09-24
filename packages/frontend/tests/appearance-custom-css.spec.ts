import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { CUSTOM_CSS_MAX_BYTES, CUSTOM_CSS_STYLE_ID, SAFE_UI_RECOVERY_PATH } from '../src/lib/custom-css';

async function signInAsAdmin(page: Page, request: APIRequestContext) {
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

async function goToAppearance(page: Page, request: APIRequestContext) {
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=appearance');
}

async function openAdvanced(page: Page) {
  const trigger = page.getByRole('button', { name: /Advanced — Custom CSS/i });
  if (await trigger.getAttribute('data-state') !== 'open') {
    await trigger.click();
  }
  await expect(page.getByLabel('Custom CSS editor')).toBeVisible();
}

function styleEl(page: Page) {
  return page.locator(`#${CUSTOM_CSS_STYLE_ID}`);
}

async function expectStyleText(page: Page, css: string) {
  await expect(styleEl(page)).toHaveCount(1);
  await expect.poll(async () => styleEl(page).evaluate((el) => el.textContent)).toBe(css);
}

async function readUiState(page: Page) {
  const raw = await page.evaluate(() => localStorage.getItem('ts6-ui'));
  if (!raw) {
    // Defaults may remain memory-only until the first store write — nudge Part A.
    await page.goto('/settings?tab=appearance');
    await page.getByRole('button', { name: 'Dark base theme' }).click();
  }
  await page.waitForFunction(() => !!localStorage.getItem('ts6-ui'));
  return page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!).state);
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('custom CSS defaults disabled and inert until saved and enabled', async ({ page, request }) => {
  await goToAppearance(page, request);
  await openAdvanced(page);

  await expect(page.getByLabel('Enable custom CSS')).not.toBeChecked();
  await expect(styleEl(page)).toHaveCount(0);
  await expect(page.getByText(SAFE_UI_RECOVERY_PATH)).toBeVisible();

  await page.getByLabel('Custom CSS editor').fill('body { outline: 2px solid magenta; }');
  await expect(styleEl(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Save CSS' }).click();
  await expect(styleEl(page)).toHaveCount(0);

  const stored = await readUiState(page);
  expect(stored.customCssText).toContain('outline');
  expect(stored.customCssEnabled).toBe(false);

  await page.getByLabel('Enable custom CSS').click();
  await expectStyleText(page, 'body { outline: 2px solid magenta; }');
});

test('disable preserves text; reset clears text and disables while keeping Part A prefs', async ({ page, request }) => {
  await goToAppearance(page, request);
  await page.getByRole('button', { name: 'Black base theme' }).click();
  await page.getByRole('button', { name: 'Violet accent' }).click();
  await page.getByRole('button', { name: 'Dots background', exact: true }).click();

  await openAdvanced(page);
  await page.getByLabel('Custom CSS editor').fill('.app-viewport { --probe: 1; }');
  await page.getByRole('button', { name: 'Save CSS' }).click();
  await page.getByLabel('Enable custom CSS').click();
  await expect(styleEl(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(styleEl(page)).toHaveCount(0);
  expect((await readUiState(page)).customCssText).toContain('--probe');
  expect((await readUiState(page)).customCssEnabled).toBe(false);

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Reset custom CSS' }).click();
  await expect(page.getByLabel('Custom CSS editor')).toHaveValue('');
  const state = await readUiState(page);
  expect(state.customCssText).toBe('');
  expect(state.customCssEnabled).toBe(false);
  expect(state.baseTheme).toBe('black');
  expect(state.accent).toBe('violet');
  expect(state.background).toBe('dots');
});

test('reset confirmation can be cancelled', async ({ page, request }) => {
  await goToAppearance(page, request);
  await openAdvanced(page);
  await page.getByLabel('Custom CSS editor').fill('/* keep me */');
  await page.getByRole('button', { name: 'Save CSS' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect((await readUiState(page)).customCssText).toContain('keep me');
});

test('enable / save / disable / reload preserve committed state', async ({ page, request }) => {
  await goToAppearance(page, request);
  await openAdvanced(page);
  await page.getByLabel('Custom CSS editor').fill('header { --css-reload: 1; }');
  await page.getByRole('button', { name: 'Save CSS' }).click();
  await page.getByLabel('Enable custom CSS').click();
  await expectStyleText(page, 'header { --css-reload: 1; }');

  await page.reload();
  await expectStyleText(page, 'header { --css-reload: 1; }');
  const state = await readUiState(page);
  expect(state.customCssEnabled).toBe(true);
  expect(state.customCssText).toContain('--css-reload');
});

test('migration from version 5 preserves Part A prefs and adds CSS defaults', async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: {
        sidebarCollapsed: true,
        sidebarSections: { overview: false, management: true, security: true, content: true, system: true, automation: true },
        baseTheme: 'black',
        accent: 'amber',
        background: 'aurora',
        backgroundMotion: 'off',
        backgroundIntensity: 'strong',
        permissionLabelMode: 'technical',
        showQueryClients: true,
      },
      version: 5,
    }));
  });

  await signInAsAdmin(page, request);
  const state = await readUiState(page);
  expect(state).toMatchObject({
    sidebarCollapsed: true,
    baseTheme: 'black',
    accent: 'amber',
    background: 'aurora',
    backgroundMotion: 'off',
    backgroundIntensity: 'strong',
    permissionLabelMode: 'technical',
    showQueryClients: true,
    customCssText: '',
    customCssEnabled: false,
  });
  expect(state.sidebarSections.overview).toBe(false);
  await expect(styleEl(page)).toHaveCount(0);
});

test('malformed or oversized stored CSS falls back safely', async ({ page, request }) => {
  await page.addInitScript((maxBytes) => {
    const oversized = 'z'.repeat(maxBytes + 8);
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: {
        sidebarCollapsed: false,
        baseTheme: 'dark',
        accent: 'cyan',
        background: 'grid',
        backgroundMotion: 'system',
        backgroundIntensity: 'normal',
        customCssText: oversized,
        customCssEnabled: true,
      },
      version: 6,
    }));
  }, CUSTOM_CSS_MAX_BYTES);

  await signInAsAdmin(page, request);
  // Touch the store so sanitized values are re-persisted.
  await page.goto('/settings?tab=appearance');
  await page.getByRole('button', { name: 'Dark base theme' }).click();
  const state = await readUiState(page);
  expect(state.customCssText).toBe('');
  expect(state.customCssEnabled).toBe(false);
  await expect(styleEl(page)).toHaveCount(0);
});

test('editor rejects oversized paste visibly without activating', async ({ page, request }) => {
  await goToAppearance(page, request);
  await openAdvanced(page);
  const oversized = 'q'.repeat(CUSTOM_CSS_MAX_BYTES + 1);
  await page.getByLabel('Custom CSS editor').fill(oversized);
  await expect(page.getByRole('alert')).toContainText('64.0 KiB');
  await page.getByRole('button', { name: 'Save CSS' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(styleEl(page)).toHaveCount(0);
  await expect(page.getByLabel('Enable custom CSS')).not.toBeChecked();
});

test('local .css import fills the draft only', async ({ page, request }) => {
  await goToAppearance(page, request);
  await openAdvanced(page);

  await page.locator('input[type="file"][accept*=".css"]').setInputFiles({
    name: 'theme.css',
    mimeType: 'text/css',
    buffer: Buffer.from('/* imported */\n.nav { color: tomato; }', 'utf8'),
  });

  await expect(page.getByLabel('Custom CSS editor')).toHaveValue(/imported/);
  await expect(styleEl(page)).toHaveCount(0);
  await expect(page.getByLabel('Enable custom CSS')).not.toBeChecked();
});

test('safe-ui latches before injection and survives SPA navigation', async ({ page, request }) => {
  const hostile = 'body { display: none !important; }';
  await page.addInitScript((css) => {
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: {
        sidebarCollapsed: false,
        baseTheme: 'dark',
        accent: 'cyan',
        background: 'grid',
        backgroundMotion: 'system',
        backgroundIntensity: 'normal',
        customCssText: css,
        customCssEnabled: true,
      },
      version: 6,
    }));
  }, hostile);

  await request.post('/__test/auth?on');
  await page.goto('/login?safe-ui=1');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
  await expect(styleEl(page)).toHaveCount(0);
  await expect(page.locator('body')).toBeVisible();

  // Client-side navigation must not clear the document latch.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: /Appearance/i }).click();
  await expect(page.getByTestId('safe-ui-banner')).toBeVisible();
  await expect(page.getByLabel('Custom CSS editor')).toBeVisible();
  await expect(styleEl(page)).toHaveCount(0);

  const state = await readUiState(page);
  expect(state.customCssText).toContain('display: none');
  expect(state.customCssEnabled).toBe(true);

  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page).toHaveURL('/dashboard');
  await expect(styleEl(page)).toHaveCount(0);
});

test('safe-ui recovers from hostile overlay / hidden nav / body display none', async ({ page, request }) => {
  const cases = [
    'body { display: none !important; }',
    'nav, aside, [data-sidebar], .app-viewport { visibility: hidden !important; }',
    'html::before { content: ""; position: fixed; inset: 0; z-index: 2147483647; background: red; }',
  ];

  await signInAsAdmin(page, request);

  for (const hostile of cases) {
    await page.evaluate((css) => {
      localStorage.setItem('ts6-ui', JSON.stringify({
        state: {
          sidebarCollapsed: false,
          baseTheme: 'dark',
          accent: 'cyan',
          background: 'grid',
          backgroundMotion: 'system',
          backgroundIntensity: 'normal',
          customCssText: css,
          customCssEnabled: true,
        },
        version: 6,
      }));
    }, hostile);

    await page.goto(SAFE_UI_RECOVERY_PATH);
    await expect(page.getByTestId('safe-ui-banner')).toBeVisible();
    await expect(styleEl(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Disable', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Custom CSS editor')).toBeVisible();
  }
});

test('safe mode blocks re-enable and does not fetch custom CSS resources', async ({ page, request }) => {
  const css = '@import url("https://example.invalid/custom.css"); body { background: url("https://example.invalid/bg.png"); }';
  await page.addInitScript((text) => {
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: {
        sidebarCollapsed: false,
        baseTheme: 'dark',
        accent: 'cyan',
        background: 'grid',
        backgroundMotion: 'system',
        backgroundIntensity: 'normal',
        customCssText: text,
        customCssEnabled: true,
      },
      version: 6,
    }));
  }, css);

  const externalHits: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('example.invalid')) externalHits.push(req.url());
  });

  await request.post('/__test/auth?on');
  await page.goto(`/login?safe-ui=1`);
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: /Appearance/i }).click();

  await expect(styleEl(page)).toHaveCount(0);
  expect(externalHits).toEqual([]);

  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  expect((await readUiState(page)).customCssEnabled).toBe(false);
  // Re-enable is blocked for this document while safe-ui is latched.
  await expect(page.getByLabel('Enable custom CSS')).toBeDisabled();
  await expect(styleEl(page)).toHaveCount(0);
  expect(externalHits).toEqual([]);
});

test('custom CSS is assigned via textContent and does not execute HTML or scripts', async ({ page, request }) => {
  await goToAppearance(page, request);
  await openAdvanced(page);
  const payload = '/* </style><script>window.__customCssXss=1</script><style> */\nbody { --x: 1; }';
  await page.getByLabel('Custom CSS editor').fill(payload);
  await page.getByRole('button', { name: 'Save CSS' }).click();
  await page.getByLabel('Enable custom CSS').click();

  await expect(styleEl(page)).toHaveCount(1);
  const text = await styleEl(page).evaluate((el) => el.textContent);
  expect(text).toContain('</style>');
  expect(await page.evaluate(() => (window as unknown as { __customCssXss?: number }).__customCssXss)).toBeUndefined();
  await expect(page.locator('script', { hasText: '__customCssXss' })).toHaveCount(0);
});

test('custom CSS is removed outside the authenticated layout', async ({ page, request }) => {
  await goToAppearance(page, request);
  await openAdvanced(page);
  await page.getByLabel('Custom CSS editor').fill('body { --auth-only: 1; }');
  await page.getByRole('button', { name: 'Save CSS' }).click();
  await page.getByLabel('Enable custom CSS').click();
  await expect(styleEl(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'Open account menu' }).click();
  await page.getByRole('menuitem', { name: /Log out/i }).click();
  await expect(page).toHaveURL('/login');
  await expect(styleEl(page)).toHaveCount(0);
});

test('custom CSS editor remains usable with a mobile viewport', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goToAppearance(page, request);
  await openAdvanced(page);
  const editor = page.getByLabel('Custom CSS editor');
  await editor.focus();
  await editor.fill('@media (max-width: 600px) { .app-viewport { --m: 1; } }');
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: 'Save CSS' }).click();
  await expect(editor).toHaveValue(/max-width/);
});
