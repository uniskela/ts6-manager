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

test('admins can allow LAN radio hosts from the radio tab', async ({ page, request }) => {
  let stored: string[] = [];
  const puts: unknown[] = [];
  await page.route('**/api/settings/radio-network', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { allowedLocalHosts: string[] };
      puts.push(body);
      stored = body.allowedLocalHosts;
    }
    await route.fulfill({ json: { allowedLocalHosts: stored } });
  });
  await page.route('**/api/servers/1/radio-stations*', async (route) => {
    await route.fulfill({ json: [] });
  });

  await signIn(page, request);
  await page.goto('/media-bots?tab=radio&server=1');

  // The editor is not always on the page
  await expect(page.getByLabel('Allowed local radio hosts')).toHaveCount(0);

  await page.getByRole('button', { name: /Local hosts/ }).click();
  await expect(page.getByRole('heading', { name: 'Local network stations' })).toBeVisible();

  const hosts = page.getByLabel('Allowed local radio hosts');
  await expect(page.getByRole('button', { name: 'Save hosts' })).toBeDisabled();
  await hosts.fill('192.168.1.20\nradio.LAN, 192.168.1.20');
  await page.getByRole('button', { name: 'Save hosts' }).click();

  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ allowedLocalHosts: ['192.168.1.20', 'radio.lan'] });
  await expect(page.getByText('Local radio hosts saved')).toBeVisible();
  await expect(hosts).toHaveValue('192.168.1.20\nradio.lan');
  await expect(page.getByRole('button', { name: 'Save hosts' })).toBeDisabled();
});
