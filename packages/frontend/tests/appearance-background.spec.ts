import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const backgrounds = ['none', 'grid', 'dots', 'glow', 'aurora', 'noise'] as const;
const baseThemes = ['light', 'dark', 'black'] as const;

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

function mainBackground(page: Page) {
  return page.locator('main.app-background-surface');
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('default background preserves the grid treatment every existing user already sees', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await expect(mainBackground(page)).toHaveAttribute('data-background', 'grid');
  await expect(mainBackground(page)).toHaveAttribute('data-intensity', 'normal');
});

test('every background preset persists across a reload', async ({ page, request }) => {
  await goToAppearance(page, request);

  for (const value of backgrounds) {
    const label = value[0].toUpperCase() + value.slice(1);
    await page.getByRole('button', { name: `${label} background`, exact: true }).click();
    await expect(mainBackground(page)).toHaveAttribute('data-background', value);
    await expect(page.getByRole('button', { name: `${label} background`, exact: true })).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(mainBackground(page)).toHaveAttribute('data-background', value);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!).state.background);
    expect(stored).toBe(value);
  }
});

test('background intensity persists and is hidden once None is selected', async ({ page, request }) => {
  await goToAppearance(page, request);

  await expect(page.getByRole('button', { name: 'Strong background intensity' })).toBeVisible();
  await page.getByRole('button', { name: 'Strong background intensity' }).click();
  await expect(mainBackground(page)).toHaveAttribute('data-intensity', 'strong');

  await page.reload();
  await expect(mainBackground(page)).toHaveAttribute('data-intensity', 'strong');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!).state.backgroundIntensity)).toBe('strong');

  await page.getByRole('button', { name: 'None background', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Strong background intensity' })).toHaveCount(0);
});

test('old ts6-ui state without background fields migrates to safe defaults', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: { sidebarCollapsed: false, baseTheme: 'black', accent: 'violet' },
      version: 1,
    }));
  });

  await page.goto('/login');
  await expect(page.getByLabel('Username')).toBeVisible();

  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!).state);
  expect(state).toMatchObject({
    baseTheme: 'black',
    accent: 'violet',
    background: 'grid',
    backgroundMotion: 'system',
    backgroundIntensity: 'normal',
  });
});

test('malformed or unknown background, motion and intensity values fall back safely', async ({ page, request }) => {
  await request.post('/__test/reset');
  await page.addInitScript(() => {
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: { sidebarCollapsed: false, baseTheme: 'dark', accent: 'cyan', background: 'plasma', backgroundMotion: 'always', backgroundIntensity: 'extreme' },
      version: 5,
    }));
  });
  await signInAsAdmin(page, request);

  await expect(mainBackground(page)).toHaveAttribute('data-background', 'grid');
  await expect(mainBackground(page)).toHaveAttribute('data-intensity', 'normal');

  // Interacting with the store re-persists the now-sanitised values.
  await page.goto('/settings?tab=appearance');
  await page.getByRole('button', { name: 'Dots background', exact: true }).click();
  await page.getByRole('button', { name: 'Grid background', exact: true }).click();
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('ts6-ui')!).state);
  expect(state).toMatchObject({ background: 'grid', backgroundMotion: 'system', backgroundIntensity: 'normal' });

  await page.evaluate(() => localStorage.setItem('ts6-ui', '{not-json'));
  await page.reload();
  await expect(mainBackground(page)).toHaveAttribute('data-background', 'grid');
});

test('motion System follows the OS reduced-motion preference', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=appearance');
  await page.getByRole('button', { name: 'Aurora background', exact: true }).click();
  await page.getByRole('button', { name: 'System motion', exact: true }).click();

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await expect(mainBackground(page)).toHaveAttribute('data-motion-resolved', 'on');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(mainBackground(page)).toHaveAttribute('data-motion-resolved', 'off');
});

test('motion Off disables decorative animation even when the OS allows motion', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=appearance');
  await page.getByRole('button', { name: 'Aurora background', exact: true }).click();
  await page.getByRole('button', { name: 'Off motion', exact: true }).click();

  await expect(mainBackground(page)).toHaveAttribute('data-motion-resolved', 'off');
  const animationName = await mainBackground(page).evaluate(el => getComputedStyle(el).animationName);
  expect(animationName).toBe('none');
});

test('motion On enables decorative animation where supported', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=appearance');
  await page.getByRole('button', { name: 'Aurora background', exact: true }).click();
  await page.getByRole('button', { name: 'On motion', exact: true }).click();

  await expect(mainBackground(page)).toHaveAttribute('data-motion-resolved', 'on');
  const animationName = await mainBackground(page).evaluate(el => getComputedStyle(el).animationName);
  expect(animationName).not.toBe('none');

  // Non-animated presets never receive an animation, regardless of motion.
  await page.getByRole('button', { name: 'Grid background', exact: true }).click();
  expect(await mainBackground(page).evaluate(el => getComputedStyle(el).animationName)).toBe('none');
});

test('backgrounds cause no document-level overflow, no pointer interception, and dialogs stay usable', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=appearance');

  for (const value of backgrounds) {
    const label = value[0].toUpperCase() + value.slice(1);
    await page.getByRole('button', { name: `${label} background`, exact: true }).click();
    await page.goto('/dashboard');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // The decorative background never intercepts pointer events: normal navigation still works.
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings/);
    await page.goto('/settings?tab=appearance');
  }

  await page.goto('/settings?tab=users');
  await page.getByRole('button', { name: 'Add User' }).click();
  await expect(page.getByRole('heading', { name: 'Add User' })).toBeVisible();
  const usernameField = page.getByPlaceholder('johndoe');
  await usernameField.fill('appearance-dialog-check');
  await expect(usernameField).toHaveValue('appearance-dialog-check');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Add User' })).toHaveCount(0);
});

async function sampleNoiseGrain(page: Page) {
  return mainBackground(page).evaluate(async (el) => {
    const match = getComputedStyle(el).backgroundImage.match(/url\((["']?)(.*?)\1\)/);
    if (!match) return null;
    const image = new Image();
    image.src = match[2];
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let maxAlpha = 0;
    let rgbAtMaxAlpha: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > maxAlpha) {
        maxAlpha = data[i + 3];
        rgbAtMaxAlpha = [data[i], data[i + 1], data[i + 2]];
      }
    }
    return { maxAlpha, rgb: rgbAtMaxAlpha };
  });
}

test('noise grain is visible and appropriately tinted on both Light and Dark/Black themes', async ({ page, request }) => {
  await goToAppearance(page, request);
  await page.getByRole('button', { name: 'Noise background', exact: true }).click();

  await page.getByRole('button', { name: 'Light base theme' }).click();
  const lightGrain = await sampleNoiseGrain(page);
  expect(lightGrain, 'light theme noise should render visible grain').not.toBeNull();
  expect(lightGrain!.maxAlpha).toBeGreaterThan(0);
  expect(lightGrain!.rgb, 'light theme grain should be dark-tinted').toEqual([0, 0, 0]);

  await page.getByRole('button', { name: 'Dark base theme' }).click();
  const darkGrain = await sampleNoiseGrain(page);
  expect(darkGrain, 'dark theme noise should render visible grain').not.toBeNull();
  expect(darkGrain!.maxAlpha).toBeGreaterThan(0);
  expect(darkGrain!.rgb, 'dark theme grain should be light-tinted so it is visible').toEqual([255, 255, 255]);

  await page.getByRole('button', { name: 'Black base theme' }).click();
  const blackGrain = await sampleNoiseGrain(page);
  expect(blackGrain!.maxAlpha).toBeGreaterThan(0);
  expect(blackGrain!.rgb).toEqual([255, 255, 255]);
});

test('background combinations preserve readable contrast across Light, Dark and Black themes', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/settings?tab=appearance');

  for (const baseTheme of baseThemes) {
    const label = baseTheme[0].toUpperCase() + baseTheme.slice(1);
    await page.getByRole('button', { name: `${label} base theme` }).click();

    for (const value of backgrounds) {
      const backgroundLabel = value[0].toUpperCase() + value.slice(1);
      await page.getByRole('button', { name: `${backgroundLabel} background`, exact: true }).click();
      if (value !== 'none') {
        await page.getByRole('button', { name: 'Strong background intensity' }).click();
      }

      const colours = await page.evaluate(() => {
        const heading = document.querySelector('h1');
        if (!heading) return null;
        const style = getComputedStyle(heading);
        return { color: style.color, background: getComputedStyle(document.body).backgroundColor };
      });
      expect(colours).not.toBeNull();
      expect(colours!.color).not.toBe(colours!.background);
    }
  }
});
