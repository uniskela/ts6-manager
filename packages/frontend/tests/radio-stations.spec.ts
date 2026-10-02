import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

async function signIn(page: Page, request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/docs?on');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

async function radioFixture(page: Page, saveGate?: Promise<void>, savedUrl = 'https://example.com/live') {
  let station = { id: 7, serverConfigId: 1, name: 'Original station', url: savedUrl, genre: 'Rock', imageUrl: null };
  const updates: unknown[] = [];
  await page.route('**/api/servers/1/radio-stations', (route) => route.fulfill({ json: [station] }));
  await page.route('**/api/servers/1/radio-stations/7', async (route) => {
    expect(route.request().method()).toBe('PUT');
    const data = route.request().postDataJSON();
    updates.push(data);
    await saveGate;
    if (data.url === 'https://unresolvable-station.invalid/live') {
      await route.fulfill({ status: 400, json: { error: 'Invalid URL: Hostname "unresolvable-station.invalid" could not be resolved' } });
      return;
    }
    if (data.url === 'http://192.168.1.10/live') {
      await route.fulfill({ status: 400, json: { error: 'Invalid URL: Private/reserved IP addresses are blocked' } });
      return;
    }
    station = { ...station, ...data, genre: data.genre || null };
    await route.fulfill({ json: station });
  });
  return updates;
}

for (const width of [1400, 390]) {
  test(`edit a radio station and clear its mood at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const updates = await radioFixture(page);
    await signIn(page, request);
    await page.goto('/media-bots?tab=radio&server=1');
    await page.getByRole('button', { name: /^Edit / }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit station' });
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Original station');
    await expect(dialog.getByLabel('Stream URL')).toHaveValue('https://example.com/live');
    await expect(dialog.getByLabel('Mood or genre')).toHaveValue('Rock');
    await expect(dialog.getByLabel('Mood or genre')).toHaveAttribute('placeholder', 'Chill, Focus, Party…');
    await dialog.getByLabel('Name', { exact: true }).fill('Updated station');
    await dialog.getByLabel('Stream URL').fill('https://example.com/new-stream');
    await dialog.getByLabel('Mood or genre').fill('');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('Station updated', { exact: true })).toBeVisible();
    await expect(page.getByText('Updated station', { exact: true })).toBeVisible();
    expect(updates).toEqual([{ name: 'Updated station', url: 'https://example.com/new-stream', genre: '' }]);

    await page.getByRole('button', { name: /^Edit / }).click();
    await expect(dialog.getByLabel('Mood or genre')).toHaveValue('');
    await dialog.getByLabel('Name', { exact: true }).fill('Unsaved name');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(updates).toHaveLength(1);
    await page.getByRole('button', { name: 'Add Station', exact: true }).click();
    const addDialog = page.getByRole('dialog', { name: 'Add Radio Station' });
    await expect(addDialog.getByLabel('Name', { exact: true })).toHaveValue('');
    await expect(addDialog.getByLabel('Stream URL')).toHaveValue('');
    await expect(addDialog.getByLabel('Mood or genre')).toHaveValue('');
    await expect(addDialog.getByRole('button', { name: 'Add Station', exact: true })).toBeDisabled();
  });
}

test('a rejected station edit keeps the form and saved station unchanged', async ({ page, request }) => {
  await radioFixture(page);
  await signIn(page, request);
  await page.goto('/media-bots?tab=radio&server=1');
  await page.getByRole('button', { name: /^Edit / }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit station' });
  await dialog.getByLabel('Stream URL').fill('http://192.168.1.10/live');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Invalid URL: Private/reserved IP addresses are blocked', { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Stream URL')).toHaveValue('http://192.168.1.10/live');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: /^Edit / }).click();
  await expect(dialog.getByLabel('Stream URL')).toHaveValue('https://example.com/live');
});

for (const field of ['name', 'genre'] as const) {
  test(`${field}-only edits omit an unchanged URL whose hostname no longer resolves`, async ({ page, request }) => {
    const savedUrl = 'https://unresolvable-station.invalid/live';
    const updates = await radioFixture(page, undefined, savedUrl);
    await signIn(page, request);
    await page.goto('/media-bots?tab=radio&server=1');
    await page.getByRole('button', { name: /^Edit / }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit station' });
    await expect(dialog.getByLabel('Stream URL')).toHaveValue(savedUrl);
    await dialog.getByLabel(field === 'name' ? 'Name' : 'Mood or genre', { exact: true }).fill(field === 'name' ? 'Renamed station' : 'Focus');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => updates.length).toBe(1);
    expect(updates).toEqual([field === 'name'
      ? { name: 'Renamed station', genre: 'Rock' }
      : { name: 'Original station', genre: 'Focus' }]);
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('Station updated', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Edit / }).click();
    await expect(dialog.getByLabel('Stream URL')).toHaveValue(savedUrl);
  });
}

test('a pending save keeps the station form open until it completes', async ({ page, request }) => {
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const updates = await radioFixture(page, saveGate);
  await signIn(page, request);
  await page.goto('/media-bots?tab=radio&server=1');
  await page.getByRole('button', { name: /^Edit / }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit station' });
  await dialog.getByLabel('Name', { exact: true }).fill('Saved station');
  try {
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => updates.length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Name', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Stream URL')).toBeDisabled();
    await expect(dialog.getByLabel('Mood or genre')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Station updated', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved station', { exact: true })).toBeVisible();
});
