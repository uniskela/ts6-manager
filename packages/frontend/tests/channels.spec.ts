import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signIn(page: Page, request: APIRequestContext, role: 'admin' | 'viewer' = 'admin') {
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/channels?scenario=normal');
  await request.post(`/__test/auth?on&role=${role}`);
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard', { timeout: 15_000 });
  await page.goto('/channels');
  await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('admin can move a channel with an accessible dialog and one request', async ({ page, request }) => {
  await signIn(page, request);
  await expect(page.getByRole('button', { name: 'Move Support' })).toBeVisible();

  await page.getByRole('button', { name: 'Move Support' }).click();
  await expect(page.getByRole('heading', { name: 'Move Channel' })).toBeVisible();
  await expect(page.getByText('Support (CID 2)')).toBeVisible();

  await page.getByRole('combobox', { name: 'Destination channel' }).click();
  await expect(page.getByRole('option', { name: 'Top level / root' })).toBeVisible();
  await expect(page.getByRole('option', { name: /Lobby \(#1\)/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Nested support/ })).toHaveCount(0);
  await page.getByRole('option', { name: 'Top level / root' }).click();
  await page.getByRole('button', { name: 'Move Channel' }).click();
  await expect(page.getByRole('heading', { name: 'Move Channel' })).toHaveCount(0);

  const state = await request.get('/__test/state').then((response) => response.json());
  expect(state.channelRequests).toEqual([{ method: 'POST', configId: 1, sid: 1, cid: 2, body: { cpid: 0 } }]);
});

test('cancel performs no channel move and failed moves keep the dialog open', async ({ page, request }) => {
  await signIn(page, request);
  await page.getByRole('button', { name: 'Move Support' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect((await request.get('/__test/state').then((response) => response.json())).channelRequests).toHaveLength(0);

  await request.post('/__test/channels?scenario=move-failure');
  await page.getByRole('button', { name: 'Move Support' }).click();
  await page.getByRole('combobox', { name: 'Destination channel' }).click();
  await page.getByRole('option', { name: /Diagnostics/ }).click();
  await page.getByRole('button', { name: 'Move Channel' }).click();
  await expect(page.getByRole('heading', { name: 'Move Channel' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('TeamSpeak rejected this channel move');
});

test('Query clients are hidden by default and an admin can reveal diagnostics without changing counts', async ({ page, request }) => {
  await signIn(page, request);
  await expect(page.getByText('Alice')).toBeVisible();
  await expect(page.getByText('serveradmin')).toHaveCount(0);
  await expect(page.getByText('2 users online')).toBeVisible();

  await page.getByRole('switch', { name: 'Show Query clients' }).click();
  await expect(page.getByText('Query sessions (2)')).toBeVisible();
  await expect(page.getByText('serveradmin')).toBeVisible();
  await expect(page.getByText('TS6-WebUI Query')).toBeVisible();
  await expect(page.getByText('2 users online')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Show Query clients' })).toBeChecked();
  await expect(page.getByText('Query sessions (2)')).toBeVisible();
});

test('non-admins never see Query controls or entries even when storage is seeded', async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ts6-ui', JSON.stringify({ version: 4, state: { showQueryClients: true } }));
  });
  await signIn(page, request, 'viewer');
  await expect(page.getByRole('button', { name: 'Move Support' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Show Query clients' })).toHaveCount(0);
  await expect(page.getByText('serveradmin')).toHaveCount(0);
  await expect(page.getByText('TS6-WebUI Query')).toHaveCount(0);
});

test('stale persisted SIDs reconcile before Channels requests and connection changes clear old SIDs', async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ts6-server', JSON.stringify({ state: { selectedConfigId: 1, selectedSid: 999 }, version: 0 }));
  });
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/servers/')) requests.push(request.url());
  });
  await signIn(page, request);
  await expect(page.getByLabel('Select virtual server')).toContainText('Operations Voice');
  expect(requests.some((url) => url.includes('/vs/999/'))).toBe(false);
  expect(requests.some((url) => url.includes('/vs/1/channels'))).toBe(true);

  await page.getByLabel('Select server connection').click();
  await page.getByRole('option', { name: 'Secondary connection' }).click();
  await expect(page.getByLabel('Select virtual server')).toContainText('Backup Voice');
  expect(requests.some((url) => url.includes('/servers/2/vs/1/'))).toBe(false);
});
