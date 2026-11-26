import { test } from '@playwright/test';
import { mockLocalHostsSetting, saveLocalHostsFromHeader, signInForLocalHosts } from './helpers/local-hosts';

test('admins can allow LAN radio hosts from the radio tab', async ({ page, request }) => {
  const puts = await mockLocalHostsSetting(page, 'radio-network');
  await page.route('**/api/servers/1/radio-stations*', async (route) => {
    await route.fulfill({ json: [] });
  });

  await signInForLocalHosts(page, request);
  await page.goto('/media-bots?tab=radio&server=1');

  await saveLocalHostsFromHeader(page, puts, {
    heading: 'Local network stations',
    label: 'Allowed local radio hosts',
    savedToast: 'Local radio hosts saved',
    hostname: 'radio.LAN',
  });
});
