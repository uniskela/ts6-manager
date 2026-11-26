import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
const existing = 111111;
const uploaded = 222222;
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="red"/></svg>');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await Promise.all([page.waitForURL('/dashboard', { timeout: 15_000 }), page.getByRole('button', { name: 'Sign In' }).click()]);
}

async function setup(page: Page, request: APIRequestContext, listStatus = 200, image = { contentType: 'image/png', body: png }) {
  let ids = [existing];
  const calls: { method: string; url: string; body: string | null }[] = [];
  await page.route(/\/api\/servers\/\d+\/vs\/\d+\/icons(\/\d+)?$/, async (r) => {
    const req = r.request();
    const single = /\/icons\/\d+$/.test(req.url());
    if (req.method() === 'GET' && single) return r.fulfill(image);
    calls.push({ method: req.method(), url: req.url(), body: req.postData() });
    if (req.method() === 'POST') { ids = [uploaded, ...ids]; return r.fulfill({ status: 201, json: { id: uploaded, size: png.length, uploadedAt: '2026-10-11T00:00:00.000Z' } }); }
    if (req.method() === 'DELETE') { ids = ids.filter((id) => !req.url().endsWith(`/${id}`)); return r.fulfill({ json: { success: true } }); }
    if (listStatus !== 200) return r.fulfill({ status: listStatus, json: { error: 'SSH credentials not configured for this server.' } });
    return r.fulfill({ json: { maxBytes: 256 * 1024, truncated: false, icons: ids.map((id) => ({ id, size: png.length, uploadedAt: '2026-10-03T00:00:00.000Z' })) } });
  });
  await page.route('**/api/channel-banners**', (r) => r.fulfill({ json: { publicUrl: 'https://ts.example.com', publicUrlSource: 'setting', maxBytes: 5 * 1024 * 1024, maxCount: 100, banners: [] } }));
  await page.route(/\/api\/servers\/\d+\/vs\/\d+\/channels\/\d+$/, (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    calls.push({ method: 'PUT', url: r.request().url(), body: r.request().postData() });
    return r.fulfill({ json: { success: true } });
  });
  for (const path of ['reset', 'dashboard?scenario=normal', 'channels?scenario=normal', 'auth?on&role=admin']) await request.post(`/__test/${path}`);
  await signIn(page);
  await page.goto('/channels');
  await page.getByRole('button', { name: 'Edit Support' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Server icons', { exact: true })).toBeVisible();
  return { calls, dialog };
}

test('picking a server icon fills the icon id and saving sends it', async ({ page, request }) => {
  const { calls, dialog } = await setup(page, request);
  await expect(dialog.getByRole('button', { name: 'No icon' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: `Use icon ${existing}` }).locator('img')).toBeVisible();
  await dialog.getByRole('button', { name: `Use icon ${existing}` }).click();
  await expect(dialog.getByLabel('Icon ID')).toHaveValue(String(existing));
  await expect(dialog.getByRole('button', { name: `Selected icon ${existing}` })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body ?? '{}').channel_icon_id)).toContain(existing);
});

test('uploading an icon selects it, and No icon clears it', async ({ page, request }) => {
  const { calls, dialog } = await setup(page, request);
  await dialog.getByLabel('Upload icon').setInputFiles({ name: 'star.png', mimeType: 'image/png', buffer: png });
  await expect(dialog.getByLabel('Icon ID')).toHaveValue(String(uploaded));
  await expect(dialog.getByRole('button', { name: `Selected icon ${uploaded}` })).toBeVisible();
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  await dialog.getByRole('button', { name: 'No icon' }).click();
  await expect(dialog.getByLabel('Icon ID')).toHaveValue('0');
});

test('deleting the selected icon clears the field', async ({ page, request }) => {
  const { calls, dialog } = await setup(page, request);
  await dialog.getByRole('button', { name: `Use icon ${existing}` }).click();
  await dialog.getByRole('button', { name: `Delete icon ${existing}` }).click();
  await page.getByRole('dialog', { name: 'Delete server icon' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'DELETE').length).toBe(1);
  await expect(dialog.getByLabel('Icon ID')).toHaveValue('0');
  await expect(dialog.getByRole('button', { name: `Use icon ${existing}` })).toHaveCount(0);
});

test('a server without file access explains why and the icon id can still be typed', async ({ page, request }) => {
  const { dialog } = await setup(page, request, 400);
  await expect(dialog.getByRole('alert').filter({ hasText: 'SSH credentials not configured' })).toBeVisible();
  await dialog.getByLabel('Icon ID').fill('4242');
  await expect(dialog.getByLabel('Icon ID')).toHaveValue('4242');
});

test('SVG icons render in the picker from an opaque data URL', async ({ page, request }) => {
  const { dialog } = await setup(page, request, 200, { contentType: 'image/svg+xml', body: svg });
  const img = dialog.getByRole('button', { name: `Use icon ${existing}` }).locator('img');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await expect(dialog.getByText(/PNG, JPEG, GIF or SVG/)).toBeVisible();
});
