import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

test('admins can allow LAN IPTV hosts from the IPTV page', async ({ page, request }) => {
  let stored: string[] = [];
  const puts: unknown[] = [];
  await page.route('**/api/settings/iptv-network', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { allowedLocalHosts: string[] };
      puts.push(body);
      stored = body.allowedLocalHosts;
    }
    await route.fulfill({ json: { allowedLocalHosts: stored } });
  });

  await signIn(page, request);
  await page.goto('/iptv');
  await expect(page.getByText('Local network sources')).toBeVisible();

  const hosts = page.getByLabel('Allowed local IPTV hosts');
  await expect(page.getByRole('button', { name: 'Save hosts' })).toBeDisabled();
  await hosts.fill('192.168.1.20\nThreadfin.LAN, 192.168.1.20');
  await page.getByRole('button', { name: 'Save hosts' }).click();

  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ allowedLocalHosts: ['192.168.1.20', 'threadfin.lan'] });
  await expect(page.getByText('Local IPTV hosts saved')).toBeVisible();
  await expect(hosts).toHaveValue('192.168.1.20\nthreadfin.lan');
  await expect(page.getByRole('button', { name: 'Save hosts' })).toBeDisabled();
});
