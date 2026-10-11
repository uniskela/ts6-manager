import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { MediaAdminDiagnosticReport } from '@ts6/common';

const report: MediaAdminDiagnosticReport = {
  checkedAt: '2026-10-11T00:00:00.000Z',
  overall: 'partial',
  checks: [
    { id: 'ffmpeg', label: 'FFmpeg', status: 'ok', version: 'ffmpeg 6.1', path: '/usr/bin/ffmpeg', message: 'ffmpeg available' },
    { id: 'ffmpeg-smoke', label: 'FFmpeg smoke', status: 'ok', message: 'Synthetic audio decoded.' },
    { id: 'opus', label: 'Opus', status: 'ok', message: 'Silent frame encoded.' },
    { id: 'deno', label: 'Deno', status: 'warning', message: 'deno was not found', remediation: 'Pull or rebuild the image.' },
  ],
  sidecar: { mode: 'url', status: 'ok', message: 'Sidecar health endpoint reachable', healthStatus: 'ok', videoPort: 10000, audioPort: 10001 },
  encoders: { status: 'ok', message: 'Software encoding available.', items: [
    { id: 'vp8', codec: 'vp8', hardware: false, available: true },
    { id: 'h264_nvenc', codec: 'h264', hardware: true, available: false, detail: 'No NVIDIA device' },
  ] },
  warnings: ['Deno: deno was not found. Pull or rebuild the image.'],
};

async function signIn(page: Page, request: APIRequestContext, role = 'admin') {
  await request.post('/__test/reset');
  await request.post(`/__test/auth?on&role=${role}`);
  await page.goto('/login');
  await page.getByLabel('Username').fill(role);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

async function openFromSidebar(page: Page) {
  const link = page.getByRole('link', { name: 'Diagnostics', exact: true });
  if (!await link.isVisible()) await page.getByRole('button', { name: 'Expand System section', exact: true }).click();
  await link.click();
  await expect(page).toHaveURL('/diagnostics');
}

test('admin sees tool results and copies a diagnostic report', async ({ page, request }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async (text: string) => { (window as unknown as { copiedReport: string }).copiedReport = text; },
    } });
  });
  await page.route('**/api/settings/media-diagnostics', route => route.fulfill({ json: report }));
  await signIn(page, request);
  await openFromSidebar(page);
  await expect(page.getByRole('heading', { name: 'Media diagnostics', exact: true })).toBeVisible();
  await expect(page.getByText('ffmpeg 6.1', { exact: true })).toBeVisible();
  await expect(page.getByText('Executable: /usr/bin/ffmpeg', { exact: true })).toBeVisible();
  await expect(page.getByText('Pull or rebuild the image.', { exact: true })).toBeVisible();
  await expect(page.getByText('Version: not reported by GET /health', { exact: true })).toBeVisible();
  const hardware = page.getByRole('listitem').filter({ has: page.getByText('h264_nvenc', { exact: true }) });
  await expect(hardware.getByText('Warning', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Last checked:' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy diagnostic report' }).click();
  const copied = await page.evaluate(() => (window as unknown as { copiedReport: string }).copiedReport);
  expect(copied).toContain('FFmpeg — ffmpeg available (ffmpeg 6.1)');
  expect(copied).toContain('executable: /usr/bin/ffmpeg');
  expect(copied).toContain('Deno: deno was not found');
  expect(copied).toContain('h264_nvenc (h264, hardware): unavailable');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('only page entry and manual Refresh run probes', async ({ page, request }) => {
  let probes = 0;
  await page.route('**/api/settings/media-diagnostics', route => {
    probes += 1;
    return route.fulfill({ json: report });
  });
  await signIn(page, request);
  await openFromSidebar(page);
  await expect(page.getByText('ffmpeg 6.1', { exact: true })).toBeVisible();
  expect(probes).toBe(1);
  await page.clock.install();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(60_000);
  expect(probes).toBe(1);
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await openFromSidebar(page);
  await expect(page.getByText('ffmpeg 6.1', { exact: true })).toBeVisible();
  expect(probes).toBe(1);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => probes).toBe(2);
});

test('failed checks require an explicit refresh to retry', async ({ page, request }) => {
  let probes = 0;
  await page.route('**/api/settings/media-diagnostics', route => {
    probes += 1;
    return probes === 1
      ? route.fulfill({ status: 429, json: { error: 'Too many runtime diagnostic requests' } })
      : route.fulfill({ json: report });
  });
  await signIn(page, request);
  await page.goto('/diagnostics');
  await expect(page.getByText('Could not run media diagnostics. Use Refresh to retry.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy diagnostic report' })).toBeDisabled();
  expect(probes).toBe(1);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('ffmpeg 6.1', { exact: true })).toBeVisible();
  expect(probes).toBe(2);
});

test('viewers cannot open diagnostics or start probes', async ({ page, request }) => {
  let probes = 0;
  await page.route('**/api/settings/media-diagnostics', route => {
    probes += 1;
    return route.fulfill({ json: report });
  });
  await signIn(page, request, 'viewer');
  await page.goto('/diagnostics');
  await expect(page).toHaveURL('/dashboard');
  await expect(page.getByRole('link', { name: 'Diagnostics', exact: true })).toHaveCount(0);
  expect(probes).toBe(0);
});
