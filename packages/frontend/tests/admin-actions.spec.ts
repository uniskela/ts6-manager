import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

type RecordedAction = {
  path: string;
  action: 'kick' | 'ban' | 'poke' | 'start' | 'stop';
  body: Record<string, unknown>;
};

async function signInAsAdmin(page: Page, request: APIRequestContext) {
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/data-table?scenario=populated');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

async function setActionScenario(request: APIRequestContext, scenario: string) {
  await request.post(`/__test/admin-actions?scenario=${scenario}`);
}

async function actionRequests(request: APIRequestContext): Promise<RecordedAction[]> {
  const state = await request.get('/__test/admin-actions').then(response => response.json());
  return state.adminActionRequests;
}

async function openClientAction(page: Page, name: string | RegExp) {
  await page.getByRole('button', { name: 'Actions for Ada Admin' }).click();
  await page.getByRole('menuitem', { name }).click();
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('Kick confirms the named client and editable reason, submits once, and waits for success', async ({ page, request }) => {
  await setActionScenario(request, 'kick-slow');
  await signInAsAdmin(page, request);
  await page.goto('/clients');

  await openClientAction(page, 'Kick from Server');
  const dialog = page.getByRole('dialog', { name: 'Kick from Server' });
  await expect(dialog.getByText('Ada Admin')).toBeVisible();
  await expect(dialog.getByLabel('Reason')).toHaveValue('Kicked by admin');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await actionRequests(request)).toHaveLength(0);

  await openClientAction(page, 'Kick from Server');
  await dialog.getByLabel('Reason').fill('Repeated disruption');
  await dialog.getByRole('button', { name: 'Kick from Server' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  await expect(dialog.getByRole('button', { name: 'Kicking…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Kicking…' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Kicked Ada Admin')).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // Simulate another server selector changing the live store while this request
  // is unresolved. The submitted URL must remain bound to the confirmed target.
  await page.getByLabel('Select server connection').dispatchEvent('click');
  const secondary = page.getByRole('option', { name: 'Secondary connection' });
  await expect(secondary).toBeAttached();
  await secondary.dispatchEvent('pointerdown', { button: 0 });
  await secondary.dispatchEvent('pointerup', { button: 0 });
  await secondary.dispatchEvent('click');
  await expect(page.getByLabel('Select server connection')).toContainText('Secondary connection');
  await expect(page.getByText('Kicked Ada Admin')).toBeVisible({ timeout: 5_000 });
  await expect(dialog).toHaveCount(0);

  const writes = await actionRequests(request);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    path: '/api/servers/1/vs/1/clients/1/kick',
    action: 'kick',
    body: { reasonid: 5, reasonmsg: 'Repeated disruption' },
  });
});

test('Kick failure is actionable, never reports success, and preserves the reason for retry', async ({ page, request }) => {
  await setActionScenario(request, 'kick-failure');
  await signInAsAdmin(page, request);
  await page.goto('/clients');
  await openClientAction(page, 'Kick from Server');
  const dialog = page.getByRole('dialog', { name: 'Kick from Server' });
  await dialog.getByLabel('Reason').fill('Flooding voice channels');
  await dialog.getByRole('button', { name: 'Kick from Server' }).click();

  await expect(dialog.getByRole('alert')).toContainText('Could not kick Ada Admin: insufficient permission to kick');
  await expect(dialog.getByLabel('Reason')).toHaveValue('Flooding voice channels');
  await expect(page.getByText('Kicked Ada Admin')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Kick from Server' })).toBeEnabled();
});

test('Ban sends selected duration and reason, maps permanent to zero, and closes only after success', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await page.goto('/clients');
  await openClientAction(page, 'Ban client');
  const dialog = page.getByRole('dialog', { name: 'Ban client' });
  await expect(dialog.getByText('Ada Admin')).toBeVisible();
  await expect(dialog).toContainText('prevent them from reconnecting');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await actionRequests(request)).toHaveLength(0);

  await openClientAction(page, 'Ban client');
  await dialog.getByLabel('Duration').click();
  await page.getByRole('option', { name: '1 day' }).click();
  await dialog.getByLabel('Reason').fill('Abusive behaviour');
  await dialog.getByRole('button', { name: 'Ban client' }).click();
  await expect(page.getByText('Banned Ada Admin')).toBeVisible();
  await expect(dialog).toHaveCount(0);

  let writes = await actionRequests(request);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    path: '/api/servers/1/vs/1/clients/1/ban',
    body: { time: 86400, banreason: 'Abusive behaviour' },
  });

  await setActionScenario(request, 'normal');
  await openClientAction(page, 'Ban client');
  await dialog.getByLabel('Duration').click();
  await page.getByRole('option', { name: 'Permanent' }).click();
  await dialog.getByRole('button', { name: 'Ban client' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await actionRequests(request)).length).toBe(1);
  writes = await actionRequests(request);
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ time: 0, banreason: 'Banned by admin' });
});

test('failed Ban remains editable and duplicate confirmation sends one request', async ({ page, request }) => {
  await setActionScenario(request, 'ban-failure');
  await signInAsAdmin(page, request);
  await page.goto('/clients');
  await openClientAction(page, 'Ban client');
  const dialog = page.getByRole('dialog', { name: 'Ban client' });
  await dialog.getByLabel('Duration').click();
  await page.getByRole('option', { name: '1 week' }).click();
  await dialog.getByLabel('Reason').fill('Continued harassment');
  await dialog.getByRole('button', { name: 'Ban client' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  await expect(dialog.getByRole('alert')).toContainText('Could not ban Ada Admin: insufficient permission to ban');
  await expect(dialog.getByLabel('Reason')).toHaveValue('Continued harassment');
  await expect(dialog.getByLabel('Duration')).toContainText('1 week');
  await expect(page.getByText('Banned Ada Admin')).toHaveCount(0);
  expect(await actionRequests(request)).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('Poke rejects blank messages, preserves failures, and sends exactly once before closing on success', async ({ page, request }) => {
  await setActionScenario(request, 'poke-failure');
  await signInAsAdmin(page, request);
  await page.goto('/clients');
  await openClientAction(page, 'Poke');
  const dialog = page.getByRole('dialog', { name: 'Poke Ada Admin' });
  await dialog.getByLabel('Message').fill('   ');
  await expect(dialog.getByRole('button', { name: 'Send poke' })).toBeDisabled();
  expect(await actionRequests(request)).toHaveLength(0);

  await dialog.getByLabel('Message').fill('Please join Support');
  await dialog.getByRole('button', { name: 'Send poke' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not poke Ada Admin: insufficient permission to poke');
  await expect(dialog.getByLabel('Message')).toHaveValue('Please join Support');
  await expect(page.getByText('Poked Ada Admin')).toHaveCount(0);

  await setActionScenario(request, 'poke-slow');
  await dialog.getByRole('button', { name: 'Send poke' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(dialog.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(page.getByText('Poked Ada Admin')).toHaveCount(0);
  await expect(page.getByText('Poked Ada Admin')).toBeVisible({ timeout: 5_000 });
  await expect(dialog).toHaveCount(0);
  const writes = await actionRequests(request);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    path: '/api/servers/1/vs/1/clients/1/poke',
    body: { msg: 'Please join Support' },
  });
});

test('Stop requires named confirmation, supports cancel, retains failure, and refreshes after one successful retry', async ({ page, request }) => {
  await setActionScenario(request, 'stop-failure');
  await signInAsAdmin(page, request);
  await page.goto('/servers');
  const card = page.getByRole('group', { name: 'Operations Voice virtual server' });
  await card.getByRole('button', { name: 'Stop' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop virtual server' });
  await expect(dialog.getByText('Operations Voice')).toBeVisible();
  await expect(dialog.getByText('SID 1')).toBeVisible();
  await expect(dialog.getByText(/connected users will be disconnected/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await actionRequests(request)).toHaveLength(0);

  await card.getByRole('button', { name: 'Stop' }).click();
  await dialog.getByRole('button', { name: 'Stop server' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(dialog.getByRole('alert')).toContainText('Could not stop Operations Voice: insufficient permission to stop');
  await expect(page.getByText('Stopped Operations Voice')).toHaveCount(0);
  expect(await actionRequests(request)).toHaveLength(1);

  await setActionScenario(request, 'stop-slow');
  await dialog.getByRole('button', { name: 'Stop server' }).click();
  await expect(dialog.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  await expect(page.getByText('Stopped Operations Voice')).toHaveCount(0);
  await expect(page.getByText('Stopped Operations Voice')).toBeVisible({ timeout: 5_000 });
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Start' })).toBeVisible();
  const state = await request.get('/__test/admin-actions').then(response => response.json());
  expect(state.adminActionRequests).toHaveLength(1);
  expect(state.adminActionRequests[0].path).toBe('/api/servers/1/virtual-servers/1/stop');
  expect(state.virtualServerListRequests).toBeGreaterThan(1);
});

test('admin dialogs remain keyboard-usable and contained at 390x844', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsAdmin(page, request);
  await page.goto('/clients');
  await openClientAction(page, 'Ban client');
  const dialog = page.getByRole('dialog', { name: 'Ban client' });
  await expect(dialog.getByLabel('Reason')).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const cancelBox = await dialog.getByRole('button', { name: 'Cancel' }).boundingBox();
  const confirmBox = await dialog.getByRole('button', { name: 'Ban client' }).boundingBox();
  expect(cancelBox?.height).toBeGreaterThanOrEqual(40);
  expect(confirmBox?.height).toBeGreaterThanOrEqual(40);
  await dialog.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(await actionRequests(request)).toHaveLength(0);
});
