import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
const existing = 'a'.repeat(32) + '.png';
const uploaded = 'b'.repeat(32) + '.png';

async function setup(page: Page, request: APIRequestContext, initialPublicUrl: string | null) {
  let publicUrl = initialPublicUrl;
  let names = [existing];
  const calls: { method: string; url: string; body: string | null }[] = [];
  const banner = (name: string) => ({
    name, size: png.length, createdAt: '2026-10-03T00:00:00.000Z', path: `/api/banners/${name}`,
    url: publicUrl ? `${publicUrl}/api/banners/${name}` : null,
  });
  await page.route('**/api/banners/*', (r) => r.fulfill({ contentType: 'image/png', body: png }));
  await page.route('**/api/channel-banners**', async (r) => {
    const req = r.request();
    calls.push({ method: req.method(), url: req.url(), body: req.postData() });
    if (req.method() === 'POST') { names = [uploaded, ...names]; return r.fulfill({ status: 201, json: banner(uploaded) }); }
    if (req.method() === 'DELETE') { names = names.filter((n) => !req.url().endsWith(n)); return r.fulfill({ json: { success: true } }); }
    return r.fulfill({ json: { publicUrl, publicUrlSource: publicUrl ? 'setting' : null, maxBytes: 5 * 1024 * 1024, maxCount: 100, banners: names.map(banner) } });
  });
  await page.route('**/api/settings/public-url', async (r) => {
    const req = r.request();
    calls.push({ method: req.method(), url: req.url(), body: req.postData() });
    publicUrl = req.postDataJSON().publicUrl.replace(/\/$/, '') || null;
    await r.fulfill({ json: { publicUrl, effective: publicUrl, source: publicUrl ? 'setting' : null } });
  });
  await page.route(/\/api\/servers\/\d+\/vs\/\d+\/channels\/\d+$/, async (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    calls.push({ method: 'PUT', url: r.request().url(), body: r.request().postData() });
    await r.fulfill({ json: { success: true } });
  });
  await request.post('/__test/reset');
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/channels?scenario=normal');
  await request.post('/__test/auth?on&role=admin');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard', { timeout: 15_000 });
  await page.goto('/channels');
  await page.getByRole('button', { name: 'Edit Support' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Hosted banners', { exact: true })).toBeVisible();
  return { calls, dialog };
}

test('uploading a banner selects its public link and saving sends it as the channel banner', async ({ page, request }) => {
  const { calls, dialog } = await setup(page, request, 'https://ts.example.com');
  await expect(dialog.getByText('https://ts.example.com', { exact: true })).toBeVisible();
  await dialog.getByLabel('Upload banner').setInputFiles({ name: 'backrooms.png', mimeType: 'image/png', buffer: png });
  const link = `https://ts.example.com/api/banners/${uploaded}`;
  await expect(dialog.getByPlaceholder('https://… or ts3image://…')).toHaveValue(link);
  await expect(dialog.getByRole('button', { name: 'Selected hosted banner' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Use this hosted banner' }).click();
  await expect(dialog.getByPlaceholder('https://… or ts3image://…')).toHaveValue(`https://ts.example.com/api/banners/${existing}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body ?? '{}').channel_banner_gfx_url))
    .toContain(`https://ts.example.com/api/banners/${existing}`);
});

test('without a public URL the picker asks for one before banners can be chosen', async ({ page, request }) => {
  const { calls, dialog } = await setup(page, request, null);
  await expect(dialog.getByRole('button', { name: 'Use this hosted banner' })).toBeDisabled();
  await dialog.getByLabel('Public URL').fill('https://voice.example.org/');
  await dialog.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect.poll(() => calls.find((c) => c.url.endsWith('/api/settings/public-url'))?.body).toBe(JSON.stringify({ publicUrl: 'https://voice.example.org/' }));
  await expect(dialog.getByRole('button', { name: 'Use this hosted banner' })).toBeEnabled();
});

test('deleting the selected banner clears the field', async ({ page, request }) => {
  const { calls, dialog } = await setup(page, request, 'https://ts.example.com');
  await dialog.getByRole('button', { name: 'Use this hosted banner' }).click();
  await dialog.getByRole('button', { name: 'Delete hosted banner' }).click();
  await page.getByRole('dialog', { name: 'Delete hosted banner' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'DELETE').length).toBe(1);
  await expect(dialog.getByPlaceholder('https://… or ts3image://…')).toHaveValue('');
});

test('changing the public URL updates a selected hosted banner link', async ({ page, request }) => {
  const { dialog } = await setup(page, request, 'https://old.example.com');
  await dialog.getByRole('button', { name: 'Use this hosted banner' }).click();
  await dialog.getByRole('button', { name: 'Change' }).click();
  await dialog.getByLabel('Public URL').fill('https://new.example.com');
  await dialog.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(dialog.getByPlaceholder('https://… or ts3image://…')).toHaveValue(`https://new.example.com/api/banners/${existing}`);
  await expect(dialog.getByRole('button', { name: 'Selected hosted banner' })).toBeVisible();
});
