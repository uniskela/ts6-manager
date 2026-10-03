import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

const refusal = "TeamSpeak refused the avatar upload. Allow file uploads for the bot's server group, or choose None.";
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');

async function setup(page: Page, request: APIRequestContext) {
  let mode = 'default';
  let md5 = 'default-image';
  const calls: { method: string; body: string | null; authorization?: string }[] = [];
  const bot = () => ({
    id: 7, name: 'Avatar Bot', nickname: 'Avatar Bot', serverConfigId: 1,
    serverConfig: { id: 1, name: 'Demo Voice Lab' }, defaultChannel: null,
    volume: 50, autoStart: false, status: 'stopped', avatarMode: mode, avatarMd5: md5, avatarError: refusal,
  });
  await page.route('**/api/music-bots', (r) => r.fulfill({ json: [bot()] }));
  await page.route('**/api/music-bots/media', (r) => r.fulfill({ json: [{
    botId: 7, botName: 'Avatar Bot', serverConfigId: 1, serverName: 'Demo Voice Lab', status: 'stopped',
    channelId: null, channelName: null, session: null, music: null, video: null,
    lastMusicStop: null, lastVideoStop: null, avatarMode: mode, avatarMd5: md5, avatarError: refusal,
  }] }));
  await page.route('**/api/music-bots/7/avatar**', async (r) => {
    const req = r.request();
    calls.push({ method: req.method(), body: req.postData(), authorization: req.headers().authorization });
    if (req.method() === 'GET') {
      await r.fulfill({ contentType: 'image/png', body: png });
    } else {
      mode = req.url().endsWith('/mode') ? req.postDataJSON().mode : 'custom';
      md5 = `${mode}-image`;
      await r.fulfill({ json: { success: true } });
    }
  });
  await request.post('/__test/reset');
  await request.post('/__test/docs?on');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
  return calls;
}

test('chosen avatars use authenticated blobs on the Hub and console, even after refusal', async ({ page, request }) => {
  const calls = await setup(page, request);
  await page.goto('/bot-hub');
  const avatar = page.getByRole('img', { name: 'Avatar for Avatar Bot' });
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute('src', /^blob:/);
  expect(calls.find((c) => c.method === 'GET')?.authorization).toMatch(/^Bearer /);
  await page.getByRole('link', { name: 'Open console for Avatar Bot' }).click();
  await expect(page.getByRole('heading', { name: 'Avatar Bot', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('header').getByRole('img', { name: 'Avatar for Avatar Bot' })).toBeVisible();
});

test('edit dialog uploads a custom image and changes to None or Use default', async ({ page, request }) => {
  const calls = await setup(page, request);
  await page.goto('/bot-hub');
  await page.getByRole('button', { name: 'Settings for Avatar Bot' }).click();
  await page.getByRole('menuitem', { name: 'Edit bot' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Avatar', exact: true })).toBeVisible();
  await expect(dialog.getByText(refusal)).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'Avatar for Avatar Bot' })).toBeVisible();
  await dialog.getByLabel('Upload avatar').setInputFiles({ name: 'custom.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => calls.filter((c) => c.method === 'PUT').length).toBe(1);
  expect(calls.find((c) => c.method === 'PUT')?.body).toContain('filename="custom.png"');
  await dialog.getByRole('button', { name: 'None', exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toContain(JSON.stringify({ mode: 'none' }));
  await expect(dialog.getByRole('img', { name: 'Avatar for Avatar Bot' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Use default' }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toContain(JSON.stringify({ mode: 'default' }));
  await expect(dialog.getByRole('img', { name: 'Avatar for Avatar Bot' })).toBeVisible();
});

test('avatar settings fit a phone screen with 44 px mode controls', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, request);
  await page.goto('/bot-hub');
  await page.getByRole('button', { name: 'Settings for Avatar Bot' }).click();
  await page.getByRole('menuitem', { name: 'Edit bot' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Use default' })).toBeVisible();
  for (const name of ['Use default', 'None']) {
    const box = await dialog.getByRole('button', { name, exact: true }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});

test('avatar object URLs are revoked when leaving a page', async ({ page, request }) => {
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL;
    (window as unknown as { revokedAvatars: string[] }).revokedAvatars = [];
    URL.revokeObjectURL = (url) => {
      (window as unknown as { revokedAvatars: string[] }).revokedAvatars.push(url);
      original(url);
    };
  });
  await setup(page, request);
  await page.goto('/bot-hub');
  await expect(page.getByRole('img', { name: 'Avatar for Avatar Bot' })).toBeVisible();
  const source = await page.getByRole('img', { name: 'Avatar for Avatar Bot' }).getAttribute('src');
  await page.getByRole('link', { name: 'Open console for Avatar Bot' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { revokedAvatars: string[] }).revokedAvatars)).toContain(source);
});
