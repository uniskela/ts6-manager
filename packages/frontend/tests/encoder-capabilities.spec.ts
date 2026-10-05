import { expect, test } from '@playwright/test';

const cmd = (enc: string) => `ffmpeg -hide_banner -nostdin -v error -f lavfi -i color=c=black:s=320x240:r=30 -frames:v 3 -c:v ${enc} -f null -`;

const caps = {
  checkedAt: '2026-10-05T09:00:00Z',
  vaapiDevice: '/dev/dri/renderD128',
  vaapiDevicePresent: false,
  hwDecode: false,
  encoders: [
    { id: 'vp8', codec: 'vp8', hardware: false, available: true, attempts: [{ command: cmd('libvpx'), ok: true, result: 'exit 0' }] },
    { id: 'vp9', codec: 'vp9', hardware: false, available: true, attempts: [{ command: cmd('libvpx-vp9'), ok: true, result: 'exit 0' }] },
    // As reported by a sidecar older than per-attempt output.
    { id: 'h264', codec: 'h264', hardware: false, available: true },
    { id: 'vp8_vaapi', codec: 'vp8', hardware: true, available: false, error: 'VAAPI device not present', skipped: 'VAAPI device /dev/dri/renderD128 not present' },
    { id: 'vp9_vaapi', codec: 'vp9', hardware: true, available: false, error: 'VAAPI device not present', skipped: 'VAAPI device /dev/dri/renderD128 not present' },
    { id: 'h264_vaapi', codec: 'h264', hardware: true, available: false, error: 'VAAPI device not present', skipped: 'VAAPI device /dev/dri/renderD128 not present' },
    {
      id: 'h264_nvenc', codec: 'h264', hardware: true, available: false,
      error: 'NVIDIA GPU/runtime not present', detail: 'Cannot load libcuda.so.1',
      attempts: [{ command: cmd('h264_nvenc'), ok: false, result: 'exit status 1', output: '[h264_nvenc @ 0x1] Cannot load libcuda.so.1' }],
    },
    {
      id: 'h264_amf', codec: 'h264', hardware: true, available: true,
      attempts: [{ command: cmd('h264_amf'), ok: true, result: 'exit 0' }],
    },
  ],
};

test('every encoder check row offers its ffmpeg output', async ({ page, request }) => {
  await page.route('**/api/settings/video-encoders**', (r) => r.fulfill({ json: caps }));
  await request.post('/__test/reset');
  await request.post('/__test/docs?on');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');

  await page.goto('/media-bots?tab=streaming');
  await page.getByRole('button', { name: /Check encoders|Re-test/ }).click();
  const summaries = page.locator('summary', { hasText: 'ffmpeg output' });
  await expect(summaries).toHaveCount(caps.encoders.length);

  const row = (label: string) => page.getByRole('listitem').filter({ hasText: label });
  await row('VP8 (software)').locator('summary').click();
  await expect(row('VP8 (software)')).toContainText('-c:v libvpx');
  await expect(row('VP8 (software)')).toContainText('exit 0');
  await expect(row('VP8 (software)')).toContainText('(no output)');

  await row('H.264 (software)').locator('summary').click();
  await expect(row('H.264 (software)')).toContainText('No ffmpeg output was reported');

  await row('VP9 (VAAPI)').locator('summary').click();
  await expect(row('VP9 (VAAPI)')).toContainText('ffmpeg was not run: VAAPI device /dev/dri/renderD128 not present.');

  await row('H.264 (NVENC)').locator('summary').click();
  await expect(row('H.264 (NVENC)')).toContainText('exit status 1');
  await expect(row('H.264 (NVENC)')).toContainText('Cannot load libcuda.so.1');

  await row('H.264 (AMF)').locator('summary').click();
  await expect(row('H.264 (AMF)').getByLabel('available', { exact: true })).toBeVisible();
  await expect(row('H.264 (AMF)')).toContainText('-c:v h264_amf');
  await expect(row('H.264 (AMF)')).toContainText('exit 0');
  await expect(page.getByText(/AMF is available when the sidecar runs natively on Windows/)).toBeVisible();

  await page.getByRole('button', { name: 'Advanced quality settings' }).click();
  await expect(page.getByText('Auto prefers hardware (VAAPI, NVENC or AMF) when a test encode succeeds')).toBeVisible();
  await page.getByLabel('Default encoder', { exact: true }).click();
  await expect(page.getByRole('option', { name: 'H.264 (AMF)', exact: true })).toBeVisible();
});
