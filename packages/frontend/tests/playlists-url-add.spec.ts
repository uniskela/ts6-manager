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

const playlist = { id: 10, name: 'Music', mode: 'stream', songCount: 0, serverConfigId: 1, musicBotId: null };
const tracks = Array.from({ length: 62 }, (_, i) => ({
  id: `vid${i}`,
  title: `A very long YouTube Music track title number ${i} that would never fit on one line of the dialog`,
  artist: 'Some Artist - Topic',
  duration: 200,
  thumbnail: '',
}));

test('adding a loaded playlist link stays inside the dialog and counts only new tracks', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.route(/\/api\/playlists(\?.*)?$/, (r) => r.fulfill({ json: [playlist] }));
  await page.route(/\/api\/playlists\/10$/, (r) => r.fulfill({ json: { ...playlist, songs: [] } }));
  await page.route(/\/music-library\/youtube\/info$/, (r) =>
    r.fulfill({ json: { type: 'playlist', title: 'Chill', items: tracks } }));
  let registered = 0;
  await page.route(/\/music-library\/youtube\/register$/, (r) => {
    const items = r.request().postDataJSON().items as unknown[];
    const results = items.map((_, i) => ({ id: registered + i + 1, source: 'youtube' }));
    registered += items.length;
    return r.fulfill({ status: 201, json: { results, errors: [] } });
  });
  let addBody: { songIds?: number[] } | null = null;
  await page.route(/\/api\/playlists\/10\/songs$/, (r) => {
    addBody = r.request().postDataJSON();
    return r.fulfill({ status: 201, json: { success: true, added: 40, alreadyInPlaylist: 22 } });
  });

  await signIn(page, request);
  await page.goto('/media-bots?tab=playlists');
  await page.getByText('Music', { exact: true }).click();
  await page.getByRole('button', { name: 'Add Songs' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Track or playlist URL').fill('https://music.youtube.com/playlist?list=PLtest');
  await dialog.getByRole('button', { name: 'Load' }).click();
  await expect(dialog.getByText('62 tracks', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/videos/)).toHaveCount(0);

  // Nothing in the dialog may push it wider than its own box.
  const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(dialog.getByRole('button', { name: 'Add 62 tracks to Music' })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('url-add-dialog.png') });

  await dialog.getByRole('button', { name: 'Add 62 tracks to Music' }).click();
  await expect(page.getByText('Added 40 tracks to Music (22 already there). Nothing downloads until played.')).toBeVisible();
  expect(addBody?.songIds).toHaveLength(62);
});
