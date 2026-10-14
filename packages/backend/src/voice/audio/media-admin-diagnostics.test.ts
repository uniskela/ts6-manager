import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { VideoEncoderCapabilities } from '@ts6/common';
import { av1DecodeSummary, diagnoseMediaAdmin, MEDIA_ADMIN_TIMEOUT_MS, probeMusicOpus } from './media-admin-diagnostics.js';

const encoders: VideoEncoderCapabilities = {
  checkedAt: '2026-01-01T00:00:00.000Z',
  vaapiDevice: '/dev/dri/renderD128',
  vaapiDevicePresent: false,
  hwDecode: false,
  encoders: [
    { id: 'vp8', codec: 'vp8', hardware: false, available: true },
    { id: 'h264_nvenc', codec: 'h264', hardware: true, available: false, error: 'no nvidia device' },
  ],
};

function passingProbe(command: string) {
  return Promise.resolve({ ok: true as const, version: `${command}-1.2.3` });
}

describe('diagnoseMediaAdmin', () => {
  it('reports versions, a local smoke, deno, and cached encoders', async () => {
    const commands: string[] = [];
    const report = await diagnoseMediaAdmin({
      env: { SIDECAR_URL: 'http://sidecar:9800', YT_DLP_PATH: '/trusted/tools/yt-dlp' },
      // Pinned to the sidecar below, so a release version bump cannot turn this into a mismatch.
      backendVersion: '1.10.2',
      probeCommand: async (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        return passingProbe(command);
      },
      probeSidecarHealth: async () => ({
        status: 'ok',
        version: '1.10.2',
        videoPort: 10000,
        audioPort: 10001,
        secret: 'SIDECAR_SECRET=should-not-leak',
      }) as { status: string },
      loadEncoders: async () => encoders,
      probeOpus: () => ({ ok: true }),
    });

    assert.equal(report.overall, 'ok');
    assert.equal(report.sidecar.version, '1.10.2');
    assert.equal(report.sidecar.videoPort, 10000);
    assert.equal(report.sidecar.audioPort, 10001);
    assert.equal(report.checks.find((check) => check.id === 'ffmpeg')?.version, 'ffmpeg-1.2.3');
    assert.equal(report.checks.find((check) => check.id === 'yt-dlp')?.path, '/trusted/tools/yt-dlp');
    assert.equal(report.checks.find((check) => check.id === 'ffmpeg-smoke')?.status, 'ok');
    assert.equal(report.checks.find((check) => check.id === 'opus')?.status, 'ok');
    assert.equal(report.checks.find((check) => check.id === 'deno')?.status, 'ok');
    assert.equal(report.encoders.items.find((item) => item.id === 'vp8')?.available, true);
    assert.equal(report.encoders.items.find((item) => item.id === 'h264_nvenc')?.available, false);
    assert.equal(report.encoders.av1Decode?.decodesOn, 'unknown');
    assert.equal(JSON.stringify(report).includes('should-not-leak'), false);
    assert.equal(JSON.stringify(report).includes('SIDECAR_SECRET'), false);
    assert.ok(commands.some((line) => line.startsWith('ffmpeg -hide_banner')));
    assert.ok(commands.some((line) => line.includes('--list-extractors')));
    assert.ok(commands.some((line) => line === '/trusted/tools/yt-dlp --ignore-config --list-extractors'));
    assert.ok(commands.some((line) => line === '/trusted/tools/yt-dlp --ignore-config --version'));
    assert.ok(commands.every((line) => !/https?:\/\//.test(line)));
    assert.equal(report.warnings.length, 0);
  });

  it('warns when deno is missing and does not ask the sidecar for encoders', async () => {
    let encoderCalls = 0;
    const report = await diagnoseMediaAdmin({
      env: { SIDECAR_BINARY_PATH: '/usr/local/bin/sidecar' },
      probeCommand: async (command) => (
        command === 'deno'
          ? { ok: false, code: 'binary_missing', message: 'deno was not found on PATH' }
          : { ok: true, version: `${command}-ok` }
      ),
      probeSidecarHealth: async () => {
        throw new Error('ECONNREFUSED');
      },
      binaryExists: () => true,
      loadEncoders: async () => {
        encoderCalls += 1;
        return encoders;
      },
      probeOpus: () => ({ ok: true }),
    });

    assert.equal(encoderCalls, 0);
    assert.equal(report.checks.find((check) => check.id === 'deno')?.status, 'warning');
    assert.equal(report.sidecar.status, 'warning');
    assert.equal(report.encoders.status, 'warning');
    assert.equal(report.overall, 'partial');
    assert.ok(report.warnings.some((line) => line.includes('Deno')));
    assert.equal(report.sidecar.version, undefined);
  });

  it('drops unknown health fields and redacts a jwt planted in a probe message', async () => {
    const jwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
    const report = await diagnoseMediaAdmin({
      env: { SIDECAR_URL: 'http://sidecar:9800', YT_DLP_PATH: '/trusted/tools/yt-dlp' },
      probeCommand: async (command) => (
        command === 'ffmpeg'
          ? { ok: false, code: 'error', message: `Authorization: Bearer ${jwt}` }
          : { ok: true, version: '1' }
      ),
      probeSidecarHealth: async () => ({ status: 'ok', password: 'hunter2' }) as { status: string },
      loadEncoders: async () => encoders,
      probeOpus: () => ({ ok: true }),
    });

    const body = JSON.stringify(report);
    assert.equal(body.includes(jwt), false);
    assert.equal(body.includes('hunter2'), false);
    assert.match(report.checks.find((check) => check.id === 'ffmpeg')?.message || '', /\[redacted/);
  });

  it('stays inside the overall deadline when probes are slow', async () => {
    const started = Date.now();
    const report = await diagnoseMediaAdmin({
      env: { SIDECAR_URL: 'http://sidecar:9800', YT_DLP_PATH: '/trusted/tools/yt-dlp' },
      overallTimeoutMs: 250,
      probeCommand: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { ok: true, version: 'slow' };
      },
      probeSidecarHealth: async () => ({ status: 'ok' }),
      loadEncoders: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return encoders;
      },
      probeOpus: () => ({ ok: true }),
    });

    assert.ok(Date.now() - started < 1_000);
    assert.notEqual(report.overall, 'ok');
  });

  it('exports a bounded default timeout', () => {
    assert.ok(MEDIA_ADMIN_TIMEOUT_MS <= 10_000);
    assert.ok(MEDIA_ADMIN_TIMEOUT_MS >= 5_000);
  });

  it('marks unstarted follow-up probes as skipped when the deadline is exhausted', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const commands: string[] = [];
    const report = await diagnoseMediaAdmin({
      env: { SIDECAR_URL: 'http://sidecar:9800' },
      probeCommand: async (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        return passingProbe(command);
      },
      probeSidecarHealth: async () => {
        now += MEDIA_ADMIN_TIMEOUT_MS;
        return { status: 'ok' };
      },
      probeOpus: () => ({ ok: true }),
      loadEncoders: async () => {
        assert.fail('Encoder probe must not run after the deadline');
      },
    });

    assert.equal(commands.length, 3);
    for (const id of ['ffmpeg-smoke', 'yt-dlp-extractors', 'deno']) {
      const check = report.checks.find((item) => item.id === id);
      assert.equal(check?.status, 'skipped');
      assert.match(check?.message || '', /overall diagnostic deadline reached/);
      assert.equal(check?.remediation, undefined);
      assert.equal(report.warnings.some((line) => line.startsWith(`${check?.label}:`)), false);
    }
  });

  it('keeps a probe that actually ran and timed out marked as failed', async () => {
    const report = await diagnoseMediaAdmin({
      env: { SIDECAR_URL: 'http://sidecar:9800' },
      probeCommand: async (command, args) => args.includes('lavfi')
        ? { ok: false, code: 'timeout', message: 'ffmpeg did not respond within 2000ms' }
        : passingProbe(command),
      probeSidecarHealth: async () => ({ status: 'ok' }),
      probeOpus: () => ({ ok: true }),
      loadEncoders: async () => encoders,
    });
    const check = report.checks.find((item) => item.id === 'ffmpeg-smoke');
    assert.equal(check?.status, 'fail');
    assert.match(check?.message || '', /did not respond/);
  });

  it('reports unhealthy sidecars and skips encoder probes', async () => {
    let encoderCalls = 0;
    const report = await diagnoseMediaAdmin({
      env: { SIDECAR_URL: 'http://sidecar:9800' },
      probeCommand: passingProbe,
      probeSidecarHealth: async () => ({ status: 'error' }),
      loadEncoders: async () => {
        encoderCalls += 1;
        return encoders;
      },
      probeOpus: () => ({ ok: true }),
    });
    assert.equal(report.sidecar.status, 'fail');
    assert.equal(report.sidecar.healthStatus, 'error');
    assert.equal(report.overall, 'partial');
    assert.equal(encoderCalls, 0);
  });

  it('warns about mismatched sidecar releases while still reporting encoders', async () => {
    const report = await diagnoseMediaAdmin({
      env: { SIDECAR_URL: 'http://sidecar:9800' },
      backendVersion: '1.11.0',
      probeCommand: passingProbe,
      probeSidecarHealth: async () => ({ status: 'ok', version: '1.10.2' }),
      loadEncoders: async () => encoders,
      probeOpus: () => ({ ok: true }),
    });
    assert.equal(report.sidecar.status, 'warning');
    assert.equal(report.overall, 'partial');
    assert.ok(report.encoders.items.length > 0);
    assert.ok(report.warnings.some(line => line.includes('does not match backend')));
  });

  it('does not mark a malformed HTTP health response as healthy', async () => {
    let requestedPath: string | undefined;
    const server = createServer((req, res) => {
      requestedPath = req.url;
      res.end('<html>wrong service</html>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let encoderCalls = 0;
    try {
      const report = await diagnoseMediaAdmin({
        env: { SIDECAR_URL: `http://127.0.0.1:${address.port}///` },
        probeCommand: passingProbe,
        probeOpus: () => ({ ok: true }),
        loadEncoders: async () => {
          encoderCalls += 1;
          return encoders;
        },
      });
      assert.equal(report.sidecar.status, 'fail');
      assert.equal(encoderCalls, 0);
      assert.equal(requestedPath, '/health');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it('keeps successful tool results when loading encoder capabilities fails', async () => {
    const report = await diagnoseMediaAdmin({
      env: { SIDECAR_URL: 'http://sidecar:9800' },
      probeCommand: passingProbe,
      probeSidecarHealth: async () => ({ status: 'ok' }),
      probeOpus: () => ({ ok: true }),
      loadEncoders: async () => { throw new Error('timeout'); },
    });
    assert.equal(report.sidecar.status, 'ok');
    assert.ok(report.checks.every((check) => check.status === 'ok'));
    assert.equal(report.encoders.status, 'warning');
    assert.deepEqual(report.encoders.items, []);
    assert.equal(report.overall, 'partial');
    assert.match(report.encoders.message, /did not answer within the diagnostic budget/);
  });

  it('preserves absolute executable paths without changing them', async () => {
    const commands: string[] = [];
    const report = await diagnoseMediaAdmin({
      env: { YT_DLP_PATH: '/trusted/media tools/yt-dlp ', SIDECAR_URL: 'http://sidecar:9800' },
      probeCommand: async (command) => {
        commands.push(command);
        return { ok: true, version: '1' };
      },
      probeSidecarHealth: async () => ({ status: 'ok' }),
      probeOpus: () => ({ ok: true }),
      loadEncoders: async () => encoders,
    });
    assert.equal(commands.filter((command) => command === '/trusted/media tools/yt-dlp ').length, 2);
    assert.equal(report.checks.find((check) => check.id === 'yt-dlp')?.path, '/trusted/media tools/yt-dlp ');
    assert.ok(commands.includes('deno'));
  });
});

describe('av1DecodeSummary', () => {
  const vaapi = { hwaccel: 'vaapi' as const, device: '/dev/dri/renderD128', available: true };

  it('says AV1 decodes on the GPU only when a test decode passed and hardware decoding is on', () => {
    const r = av1DecodeSummary({ ...encoders, hwDecode: true, av1HwDecode: true, av1Decode: [vaapi] });
    assert.equal(r.decodesOn, 'gpu');
    assert.match(r.message, /decode on the GPU \(vaapi\)/);
    assert.deepEqual(r.items, [{ hwaccel: 'vaapi', available: true }]);
  });

  it('says VIDEO_HW_DECODE is off, not that no GPU exists, when the sidecar skipped the test decode', () => {
    // A 1.11 sidecar with hardware decoding off reports an empty list.
    const r = av1DecodeSummary({ ...encoders, hwDecode: false, av1HwDecode: false, av1Decode: [] });
    assert.equal(r.decodesOn, 'cpu');
    assert.match(r.message, /VIDEO_HW_DECODE is off/);
    assert.doesNotMatch(r.message, /No GPU|before 1\.11/);
  });

  it("keeps the failed test decode's reason and points Intel users at the driver choice", () => {
    const failed = { ...vaapi, available: false, error: 'internal decoding error (signal: segmentation fault)' };
    const r = av1DecodeSummary({ ...encoders, hwDecode: true, av1HwDecode: false, av1Decode: [failed] });
    assert.equal(r.decodesOn, 'cpu');
    assert.match(r.message, /libdav1d/);
    assert.match(r.message, /INTEL_VAAPI_DRIVER/);
    assert.equal(r.items[0]?.detail, 'internal decoding error (signal: segmentation fault)');
  });

  it('says so when there was no GPU to test, or the sidecar is too old to report it', () => {
    assert.match(av1DecodeSummary({ ...encoders, hwDecode: true, av1HwDecode: false, av1Decode: [] }).message, /No GPU to test/);
    assert.equal(av1DecodeSummary(encoders).decodesOn, 'unknown');
  });
});

describe('probeMusicOpus', () => {
  it('encodes one silent frame with bundled opusscript (no FFmpeg)', () => {
    const result = probeMusicOpus();
    assert.equal(result.ok, true);
  });
});
