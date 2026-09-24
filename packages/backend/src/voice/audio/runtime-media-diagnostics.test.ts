import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_OVERALL_TIMEOUT_MS,
  diagnoseRuntimeMedia,
  probeCommandVersion,
} from './runtime-media-diagnostics.js';

describe('diagnoseRuntimeMedia', () => {
  it('returns ok when all injected probes pass', async () => {
    const report = await diagnoseRuntimeMedia({
      env: { SIDECAR_URL: 'http://sidecar:9800' },
      probeCommand: async (command) => ({ ok: true, version: `${command}-1.0` }),
      probeSidecarHealth: async () => ({ status: 'healthy' }),
      binaryExists: () => true,
    });

    assert.equal(report.overall, 'ok');
    assert.equal(report.meta.sidecarMode, 'url');
    assert.equal(report.stages.length, 4);
    assert.ok(report.stages.every((s) => s.status === 'ok'));
    assert.equal(report.stages.find((s) => s.id === 'yt-dlp')?.version, 'yt-dlp-1.0');
    assert.ok(Date.parse(report.checkedAt));
  });

  it('marks missing binaries as fail without hanging', async () => {
    const started = Date.now();
    const report = await diagnoseRuntimeMedia({
      env: {},
      overallTimeoutMs: 2_000,
      stageTimeoutMs: 500,
      sidecarTimeoutMs: 300,
      probeCommand: async () => ({
        ok: false,
        code: 'binary_missing',
        message: 'missing',
      }),
      probeSidecarHealth: async () => {
        throw new Error('unreachable');
      },
      binaryExists: () => false,
    });

    assert.ok(Date.now() - started < 1_500);
    assert.equal(report.overall, 'fail');
    assert.equal(report.meta.sidecarMode, 'local');
    assert.equal(report.stages.find((s) => s.id === 'yt-dlp')?.code, 'binary_missing');
    assert.equal(report.stages.find((s) => s.id === 'sidecar')?.code, 'binary_missing');
  });

  it('skips local sidecar listening when binary exists but health fails', async () => {
    const report = await diagnoseRuntimeMedia({
      env: { SIDECAR_BINARY_PATH: '/usr/local/bin/sidecar' },
      probeCommand: async (command) => ({ ok: true, version: `${command}-ok` }),
      probeSidecarHealth: async () => {
        throw new Error('ECONNREFUSED');
      },
      binaryExists: () => true,
    });

    assert.equal(report.meta.sidecarMode, 'local');
    const sidecar = report.stages.find((s) => s.id === 'sidecar');
    assert.equal(sidecar?.status, 'skipped');
    assert.equal(sidecar?.code, 'not_listening');
    assert.equal(report.overall, 'ok');
  });

  it('fails URL-mode sidecar when health is unreachable', async () => {
    const report = await diagnoseRuntimeMedia({
      env: { SIDECAR_URL: 'http://sidecar:9800' },
      probeCommand: async () => ({ ok: true, version: '1' }),
      probeSidecarHealth: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const sidecar = report.stages.find((s) => s.id === 'sidecar');
    assert.equal(sidecar?.status, 'fail');
    assert.equal(sidecar?.code, 'sidecar_unreachable');
    assert.equal(report.overall, 'partial');
  });

  it('terminates within overall budget when stages starve the deadline', async () => {
    const started = Date.now();
    const report = await diagnoseRuntimeMedia({
      env: { SIDECAR_URL: 'http://sidecar:9800' },
      overallTimeoutMs: 80,
      stageTimeoutMs: 200,
      sidecarTimeoutMs: 200,
      probeCommand: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, version: 'slow' };
      },
      probeSidecarHealth: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { status: 'late' };
      },
    });

    assert.ok(Date.now() - started < 500);
    assert.equal(report.stages.length, 4);
    // yt-dlp (~50ms) and ffmpeg (~100ms) finish before the 80ms overall deadline;
    // ffprobe and sidecar start after it and must be cut off.
    assert.equal(report.stages.find((s) => s.id === 'ffprobe')?.code, 'timeout');
    assert.equal(report.stages.find((s) => s.id === 'sidecar')?.code, 'timeout');
    assert.notEqual(report.overall, 'ok');
  });

  it('exports a conservative default overall timeout', () => {
    assert.ok(DEFAULT_OVERALL_TIMEOUT_MS <= 5_000);
    assert.ok(DEFAULT_OVERALL_TIMEOUT_MS >= 2_000);
  });
});

describe('probeCommandVersion', () => {
  it('kills hung commands within the stage timeout', async () => {
    const started = Date.now();
    const result = await probeCommandVersion(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      200,
    );
    assert.ok(Date.now() - started < 1_000);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'timeout');
  });

  it('reports missing binaries', async () => {
    const result = await probeCommandVersion('ts6-definitely-missing-binary-xyz', ['--version'], 500);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'binary_missing');
  });

  it('resolves (does not reject) when spawn throws synchronously', async () => {
    const result = await probeCommandVersion('', [], 200);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.code === 'error' || result.code === 'binary_missing');
    }
  });
});
