import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page, request }) => {
  await request.post('/__test/reset');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
});

test('manual connection dialog focuses the first field without opening help', async ({ page }) => {
  await page.goto('/settings?tab=connections');
  await page.getByRole('button', { name: 'Add manually' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add Connection' });
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('manual connection fields have programmatic labels and named help controls', async ({ page }) => {
  await page.goto('/settings?tab=connections');
  await page.getByRole('button', { name: 'Add manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Connection' });

  for (const label of ['Name', 'Host', 'API Key', 'SSH User', 'SSH Password']) {
    await expect(dialog.getByLabel(label, { exact: true })).toBeVisible();
  }
  await expect(dialog.getByRole('spinbutton', { name: 'WebQuery Port' })).toHaveValue('10080');
  await expect(dialog.getByRole('spinbutton', { name: 'SSH Port' })).toHaveValue('10022');
  await expect(dialog.getByRole('switch', { name: 'Use HTTPS' })).toBeVisible();

  await dialog.getByRole('button', { name: 'About Host' }).focus();
  await expect(page.getByRole('tooltip')).toContainText('TeamSpeak');
});
