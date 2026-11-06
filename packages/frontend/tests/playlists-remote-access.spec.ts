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

test('Playlists tab shows remote visibility and saves remoteAccess via Edit', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });

  const playlist = {
    id: 10,
    name: 'Lounge Mix',
    mode: 'local',
    remoteAccess: 'hidden',
    songCount: 1,
    serverConfigId: 1,
    musicBotId: null,
  };
  let detail = {
    ...playlist,
    songs: [{ id: 1, title: 'Neon Skyline', artist: 'Midnight Transit', source: 'local', duration: 214 }],
  };
  let putBody: unknown = null;

  await page.route(/\/api\/playlists(\?.*)?$/, (r) => {
    if (r.request().method() === 'PUT') return r.fallback();
    return r.fulfill({ json: [playlist] });
  });
  await page.route(/\/api\/playlists\/10$/, async (r) => {
    if (r.request().method() === 'PUT') {
      putBody = r.request().postDataJSON();
      const body = putBody as { remoteAccess?: string; name?: string };
      playlist.remoteAccess = body.remoteAccess ?? playlist.remoteAccess;
      if (body.name) playlist.name = body.name;
      detail = { ...detail, ...playlist };
      return r.fulfill({ json: detail });
    }
    return r.fulfill({ json: detail });
  });

  await signIn(page, request);
  await page.goto('/media-bots?tab=playlists');

  const row = page.getByText('Lounge Mix').locator('..');
  await expect(row.getByText('Hidden', { exact: true })).toBeVisible();

  await page.getByText('Lounge Mix').click();
  await expect(page.getByText(/Listener remote: Hidden/)).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Playlist' });
  await expect(edit).toBeVisible();
  await expect(
    edit.getByText('Hiding a playlist does not hide its songs from the listener remote library.'),
  ).toBeVisible();

  await edit.getByLabel('Listener remote visibility').click();
  await page.getByRole('option', { name: /^Browse —/ }).click();
  await edit.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => putBody).toMatchObject({ remoteAccess: 'browse', name: 'Lounge Mix' });
  await expect(page.getByText(/Listener remote: Browse/)).toBeVisible();
  await expect(page.getByText('Browse', { exact: true }).first()).toBeVisible();
});
