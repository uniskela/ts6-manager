import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Sign in as the Playwright admin with docs and auth hooks enabled. */
export async function signInForLocalHosts(page: Page, request: APIRequestContext): Promise<void> {
  await request.post('/__test/reset');
  await request.post('/__test/docs?on');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

/** Serve one allowlist setting from memory and record every PUT body. */
export async function mockLocalHostsSetting(page: Page, path: string): Promise<unknown[]> {
  let stored: string[] = [];
  const puts: unknown[] = [];
  await page.route(`**/api/settings/${path}`, async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { allowedLocalHosts: string[] };
      puts.push(body);
      stored = body.allowedLocalHosts;
    }
    await route.fulfill({ json: { allowedLocalHosts: stored } });
  });
  return puts;
}

/**
 * Open the Local hosts dialog from the page header, save a messy list and
 * check it comes back normalized and deduped.
 */
export async function saveLocalHostsFromHeader(page: Page, puts: unknown[], copy: {
  heading: string;
  label: string;
  savedToast: string;
  hostname: string;
}): Promise<void> {
  // The editor is not always on the page
  await expect(page.getByLabel(copy.label)).toHaveCount(0);

  await page.getByRole('button', { name: /Local hosts/ }).click();
  await expect(page.getByRole('heading', { name: copy.heading })).toBeVisible();

  const hosts = page.getByLabel(copy.label);
  const save = page.getByRole('button', { name: 'Save hosts' });
  await expect(save).toBeDisabled();
  await hosts.fill(`192.168.1.20\n${copy.hostname}, 192.168.1.20`);
  await save.click();

  const normalized = copy.hostname.toLowerCase();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ allowedLocalHosts: ['192.168.1.20', normalized] });
  await expect(page.getByText(copy.savedToast)).toBeVisible();
  await expect(hosts).toHaveValue(`192.168.1.20\n${normalized}`);
  await expect(save).toBeDisabled();
}
