import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signIn(page: Page, request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

const playlist = (id: number, name: string, serverConfigId: number) => ({
  id, name, mode: 'local', songCount: 1, serverConfigId, musicBotId: null,
});

async function mockPlaylists(page: Page) {
  await page.route(/\/api\/playlists(\?.*)?$/, (r) => {
    const server = new URL(r.request().url()).searchParams.get('serverConfigId');
    return r.fulfill({ json: server === '2' ? [playlist(20, 'Backup Mix', 2)] : [playlist(10, 'Lounge Mix', 1)] });
  });
  await page.route(/\/api\/playlists\/10$/, (r) => r.fulfill({
    json: { ...playlist(10, 'Lounge Mix', 1), songs: [{ id: 1, title: 'Neon Skyline', artist: 'Midnight Transit', source: 'local', duration: 214 }] },
  }));
}

test('switching servers clears the previous server\'s selected playlist', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await mockPlaylists(page);
  await signIn(page, request);
  await page.goto('/media-bots?tab=playlists');

  await page.getByText('Lounge Mix').click();
  await expect(page.getByText('Neon Skyline')).toBeVisible();

  await page.getByRole('combobox', { name: 'Select server connection' }).click();
  await page.getByRole('option', { name: /Secondary connection/ }).click();

  await expect(page.getByText('Backup Mix')).toBeVisible();
  await expect(page.getByText('Neon Skyline')).toHaveCount(0);
  await expect(page.getByText('Select a playlist to view its songs')).toBeVisible();
});

test('a new playlist is created on the selected server', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await mockPlaylists(page);
  let created: unknown = null;
  await page.route(/\/api\/playlists$/, (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    created = r.request().postDataJSON();
    return r.fulfill({ status: 201, json: { id: 30, name: 'Night Drive', mode: 'local' } });
  });
  await signIn(page, request);
  await page.goto('/media-bots?tab=playlists');
  await page.getByRole('combobox', { name: 'Select server connection' }).click();
  await page.getByRole('option', { name: /Secondary connection/ }).click();
  await expect(page.getByText('Backup Mix')).toBeVisible();

  await page.getByRole('button', { name: 'New Playlist' }).click();
  await page.getByRole('dialog').getByRole('textbox').first().fill('Night Drive');
  await page.getByRole('dialog').getByRole('button', { name: /^Create/ }).click();
  await expect.poll(() => created).toMatchObject({ name: 'Night Drive', serverConfigId: 2 });
});
