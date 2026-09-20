import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signInForPermissions(page: Page, request: APIRequestContext) {
  await request.post('/__test/dashboard?scenario=normal');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
  await page.goto('/permissions');
  await expect(page.getByRole('heading', { name: 'Permissions' })).toBeVisible();
}

async function selectEntity(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByText('Select an entity from the left panel')).toHaveCount(0);
}

async function stageChannelPower(page: Page, value: string, expectedChanges = 1) {
  const category = page.getByRole('button', { name: /Channel \(Values\)/ });
  if ((await category.getAttribute('aria-expanded')) !== 'true') await category.click();
  await page.getByRole('spinbutton', { name: 'Needed channel modify power value' }).fill(value);
  await expect(page.getByText(`${expectedChanges} unsaved ${expectedChanges === 1 ? 'change' : 'changes'}`)).toBeVisible();
}

async function stageBooleanRemoval(page: Page) {
  const category = page.getByRole('button', { name: /Virtual Server/ });
  if ((await category.getAttribute('aria-expanded')) !== 'true') await category.click();
  await page.getByRole('button', { name: 'Modify the virtual server name permission' }).click();
}

async function selectForCompare(page: Page, names: string[]) {
  for (const name of names) {
    await page.getByRole('button', { name: `Select ${name} for Compare` }).click();
  }
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('Set only describes and keeps currently assigned permissions including numeric zero', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await selectEntity(page, 'Administrators');
  await expect(page.getByText('Editing')).toBeVisible();

  const setOnly = page.getByRole('checkbox', { name: 'Set only' });
  await expect(setOnly).toBeVisible();
  await expect(setOnly).toHaveAttribute('title', 'Show currently set permissions and staged changes');
  await setOnly.check();

  await expect(page.getByRole('button', { name: /Virtual Server/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Channel \(Values\)/ })).toBeVisible();
  await page.getByPlaceholder('Search permissions...').fill('b_client_ignore_bans');
  await expect(page.getByText('No permissions match your search')).toBeVisible();
});

test('Simple and Technical labels persist while search matches IDs and descriptions', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await selectEntity(page, 'Administrators');

  const simple = page.getByRole('button', { name: 'Simple labels' });
  const technical = page.getByRole('button', { name: 'Technical labels' });
  await expect(simple).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Virtual Server/ }).click();
  await expect(page.getByText('Modify the virtual server name')).toBeVisible();
  await expect(page.getByText('b_virtualserver_modify_name')).toBeVisible();

  await page.getByPlaceholder('Search permissions...').fill('i_channel_needed_permission_modify_power');
  await expect(page.getByRole('button', { name: /Channel \(Values\)/ })).toBeVisible();
  await page.getByPlaceholder('Search permissions...').fill('Needed channel modify power');
  await expect(page.getByRole('button', { name: /Channel \(Values\)/ })).toBeVisible();

  await technical.click();
  await expect(technical).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await selectEntity(page, 'Administrators');
  await expect(page.getByRole('button', { name: 'Technical labels' })).toHaveAttribute('aria-pressed', 'true');
});

test('dirty entity switches require an explicit stay or discard decision', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await selectEntity(page, 'Administrators');
  await stageChannelPower(page, '42');

  await page.getByRole('button', { name: /^Moderators/ }).click();
  await expect(page.getByRole('heading', { name: 'Unsaved permission changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByRole('button', { name: /^Administrators/ })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('spinbutton', { name: 'Needed channel modify power value' })).toHaveValue('42');

  await page.getByRole('button', { name: /^Moderators/ }).click();
  await page.getByRole('button', { name: 'Discard & continue' }).click();
  await expect(page.getByRole('button', { name: /^Moderators/ })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('1 unsaved change')).toHaveCount(0);
});

test('dirty layer switches require an explicit decision', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await selectEntity(page, 'Administrators');
  await stageChannelPower(page, '41');

  await page.getByRole('button', { name: 'Channel Groups', exact: true }).click();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByRole('button', { name: 'Server Groups', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Administrators/ })).toHaveAttribute('aria-current', 'true');

  await page.getByRole('button', { name: 'Channel Groups', exact: true }).click();
  await page.getByRole('button', { name: 'Discard & continue' }).click();
  await expect(page.getByRole('button', { name: 'Channel Groups', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Select an entity from the left panel')).toBeVisible();
});

test('dirty SID and connection switches restore the draft owner until discarded', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await selectEntity(page, 'Administrators');
  await stageChannelPower(page, '40');

  await page.getByLabel('Select virtual server').click();
  await page.getByRole('option', { name: 'Operations Staging' }).click();
  await expect(page.getByRole('heading', { name: 'Unsaved permission changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByLabel('Select virtual server')).toContainText('Operations Voice');
  await expect(page.getByRole('spinbutton', { name: 'Needed channel modify power value' })).toHaveValue('40');

  await page.getByLabel('Select server connection').click();
  await page.getByRole('option', { name: 'Secondary connection' }).click();
  await expect(page.getByRole('heading', { name: 'Unsaved permission changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard & continue' }).click();
  await expect(page.getByLabel('Select server connection')).toContainText('Secondary connection');
  await expect(page.getByLabel('Select virtual server')).toContainText('Backup Voice');
  await expect(page.getByText('Select an entity from the left panel')).toBeVisible();
});

test('dirty drafts protect in-app navigation and browser unload', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await selectEntity(page, 'Administrators');
  await stageChannelPower(page, '39');

  const unloadPrevented = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return !window.dispatchEvent(event);
  });
  expect(unloadPrevented).toBe(true);

  await page.getByRole('link', { name: 'Channels', exact: true }).click();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL('/permissions');
  await expect(page.getByRole('spinbutton', { name: 'Needed channel modify power value' })).toHaveValue('39');

  await page.getByRole('link', { name: 'Channels', exact: true }).click();
  await page.getByRole('button', { name: 'Discard & continue' }).click();
  await expect(page).toHaveURL('/channels');
});

test('Save freezes its owner context and rejects duplicate same-tick submissions', async ({ page, request }) => {
  await request.post('/__test/permissions?scenario=slow-save');
  await signInForPermissions(page, request);
  await request.post('/__test/permissions?scenario=slow-save');
  await selectEntity(page, 'Administrators');
  await stageChannelPower(page, '38');

  await page.getByRole('button', { name: 'Save' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await page.getByLabel('Select server connection').click();
  await page.getByRole('option', { name: 'Secondary connection' }).click();
  await page.getByRole('button', { name: 'Discard & continue' }).click();
  await expect(page.getByText('Permissions saved to the original draft context')).toBeVisible();

  const state = await request.get('/__test/permissions').then(response => response.json());
  const writes = state.permissionRequests.filter((entry: { method: string }) => entry.method !== 'GET');
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toBe('/api/servers/1/vs/1/server-groups/10/permissions');
  expect(writes[0].body).toMatchObject({ permsid: 'i_channel_needed_permission_modify_power', permvalue: 38 });
});

test('a failed Save retains the owned draft with an actionable error', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await request.post('/__test/permissions?scenario=save-failure');
  await selectEntity(page, 'Administrators');
  await stageChannelPower(page, '37');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('No permission changes were saved. 1 change remains.')).toBeVisible();
  await expect(page.getByText('1 unsaved change')).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Needed channel modify power value' })).toHaveValue('37');
});

test('a partial sequential Save reports committed work and retains only the remaining draft', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await request.post('/__test/permissions?scenario=partial-failure');
  await selectEntity(page, 'Administrators');
  await stageBooleanRemoval(page);
  await stageChannelPower(page, '36', 2);
  await expect(page.getByText('2 unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('1 of 2 permission changes saved. 1 change remains.')).toBeVisible();
  await expect(page.getByText('1 unsaved change')).toBeVisible();
  const state = await request.get('/__test/permissions').then(response => response.json());
  const writes = state.permissionRequests.filter((entry: { method: string }) => entry.method !== 'GET');
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ method: 'DELETE', path: '/api/servers/1/vs/1/server-groups/10/permissions' });
  expect(writes[1]).toMatchObject({ method: 'PUT', path: '/api/servers/1/vs/1/server-groups/10/permissions' });
});

test('Compare accepts two through four same-layer entities and refuses a fifth', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await selectEntity(page, 'Administrators');
  await selectForCompare(page, ['Administrators', 'Moderators']);
  await expect(page.getByRole('button', { name: 'Compare 2 selected entities' })).toBeEnabled();
  await selectForCompare(page, ['Guests']);
  await expect(page.getByRole('button', { name: 'Compare 3 selected entities' })).toBeEnabled();
  await selectForCompare(page, ['Operators']);
  await expect(page.getByRole('button', { name: 'Compare 4 selected entities' })).toBeEnabled();
  await page.getByRole('button', { name: 'Select Auditors for Compare' }).click();
  await expect(page.getByText('Compare is limited to 4 entities')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select Auditors for Compare' })).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: 'Compare 4 selected entities' }).click();
  const compare = page.getByTestId('permissions-compare');
  for (const name of ['Administrators', 'Moderators', 'Guests', 'Operators']) {
    await expect(compare.getByRole('columnheader', { name: new RegExp(name) })).toBeVisible();
  }
  await page.getByPlaceholder('Search compared permissions...').fill('Server kick power');
  await expect(compare.getByRole('cell', { name: 'Operators: Value 75, Skip, Negate' })).toBeVisible();
  await expect(compare.getByRole('button', { name: 'Save' })).toHaveCount(0);

  const state = await request.get('/__test/permissions').then(response => response.json());
  expect(state.permissionRequests.filter((entry: { method: string }) => entry.method !== 'GET')).toHaveLength(0);
});

test('incompatible context changes clear Compare selections', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await selectForCompare(page, ['Administrators', 'Moderators']);
  await page.getByRole('button', { name: 'Channel Groups', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Compare 0 selected entities' })).toBeDisabled();

  await page.getByRole('button', { name: 'Server Groups', exact: true }).click();
  await selectForCompare(page, ['Administrators', 'Moderators']);
  await page.getByLabel('Select virtual server').click();
  await page.getByRole('option', { name: 'Operations Staging' }).click();
  await expect(page.getByRole('button', { name: 'Compare 0 selected entities' })).toBeDisabled();
});

test('permission flags expose keyboard states and remain contained on mobile themes', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('ts6-ui', JSON.stringify({
      state: { baseTheme: 'black', accent: 'amber', permissionLabelMode: 'simple' },
      version: 3,
    }));
  });
  await signInForPermissions(page, request);
  await selectEntity(page, 'Administrators');
  await page.getByRole('button', { name: /Channel \(Values\)/ }).click();

  const skip = page.getByRole('button', { name: 'Needed channel modify power Skip' });
  const negate = page.getByRole('button', { name: 'Needed channel modify power Negate' });
  await skip.focus();
  await page.keyboard.press('Space');
  await expect(skip).toHaveAttribute('aria-pressed', 'true');
  await negate.focus();
  await page.keyboard.press('Enter');
  await expect(negate).toHaveAttribute('aria-pressed', 'true');
  for (const control of [
    skip,
    negate,
    page.getByRole('button', { name: 'Simple labels' }),
    page.getByRole('button', { name: 'Server Groups', exact: true }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(40);
    expect(box?.width).toBeGreaterThanOrEqual(40);
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'amber');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Compare filters raw states without treating unset as numeric zero', async ({ page, request }) => {
  await signInForPermissions(page, request);
  await selectForCompare(page, ['Administrators', 'Moderators', 'Guests', 'Auditors']);
  await page.getByRole('button', { name: 'Compare 4 selected entities' }).click();
  const compare = page.getByTestId('permissions-compare');

  await page.getByRole('checkbox', { name: 'Set on any' }).check();
  await page.getByPlaceholder('Search compared permissions...').fill('Needed channel modify power');
  await expect(compare.getByRole('cell', { name: 'Administrators: Value 0' })).toBeVisible();
  await expect(compare.getByRole('cell', { name: 'Moderators: Value 25, Skip' })).toBeVisible();
  await expect(compare.getByRole('cell', { name: 'Guests: Value 25, Negate' })).toBeVisible();
  await expect(compare.getByRole('cell', { name: 'Auditors: Unset' })).toBeVisible();

  await page.getByRole('checkbox', { name: 'Differences only' }).check();
  await expect(compare.getByText('Needed channel modify power')).toBeVisible();
  await page.getByPlaceholder('Search compared permissions...').fill('Ignore server bans');
  await expect(compare.getByText('No permissions match the Compare filters')).toBeVisible();
});

test('Compare keeps a failed entity distinct and contains narrow horizontal scrolling', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInForPermissions(page, request);
  await request.post('/__test/permissions?scenario=compare-failure');
  await selectForCompare(page, ['Administrators', 'Moderators', 'Guests', 'Operators']);
  await page.getByRole('button', { name: 'Compare 4 selected entities' }).click();
  const compare = page.getByTestId('permissions-compare');

  const failedHeader = compare.getByRole('columnheader', { name: /Operators/ });
  await expect(failedHeader).toBeVisible();
  await expect(failedHeader.getByText('Failed to load')).toBeVisible();
  await expect(compare.getByRole('cell', { name: /Operators: Failed to load/ }).first()).toBeVisible();
  expect(await compare.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const state = await request.get('/__test/permissions').then(response => response.json());
  expect(state.permissionRequests.filter((entry: { method: string }) => entry.method !== 'GET')).toHaveLength(0);
});
