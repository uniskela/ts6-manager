import { expect, test } from '@playwright/test';
import { mockLocalHostsSetting, saveLocalHostsFromHeader, signInForLocalHosts as signIn } from './helpers/local-hosts';

test('admins can allow LAN IPTV hosts from the IPTV header', async ({ page, request }) => {
  const puts = await mockLocalHostsSetting(page, 'iptv-network');

  await signIn(page, request);
  await page.goto('/iptv');

  await saveLocalHostsFromHeader(page, puts, {
    heading: 'Local network sources',
    label: 'Allowed local IPTV hosts',
    savedToast: 'Local IPTV hosts saved',
    hostname: 'Threadfin.LAN',
  });
});

test('empty state hint opens the local hosts dialog', async ({ page, request }) => {
  await page.route('**/api/settings/iptv-network', async (route) => {
    await route.fulfill({ json: { allowedLocalHosts: [] } });
  });
  await page.route('**/api/iptv/playlists*', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [] });
      return;
    }
    await route.continue();
  });

  await signIn(page, request);
  await page.goto('/iptv');

  await page.getByRole('button', {
    name: 'Using Threadfin, xTeVe or TVHeadend? Allow its host first.',
  }).click();

  await expect(page.getByRole('heading', { name: 'Local network sources' })).toBeVisible();
  await expect(page.getByLabel('Allowed local IPTV hosts')).toBeVisible();
});
