/**
 * Bounded runtime/media diagnostics (#91 Slice 6 PR5).
 *
 * Probes yt-dlp / ffmpeg / ffprobe / sidecar on demand only. Must never run from
 * cheap health endpoints or short-interval music-bot status polls.
 */

import { spawn } from 'child_process';
import { accessSync, constants as fsConstants } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import type {
  RuntimeMediaDiagnosticReport,
  RuntimeMediaOverall,
  RuntimeMediaSidecarMode,
  RuntimeMediaStageId,
  RuntimeMediaStageResult,
} from '@ts6/common';

export const RUNTIME_MEDIA_STAGE_IDS: readonly RuntimeMediaStageId[] = [
  'yt-dlp',
  'ffmpeg',
  'ffprobe',
  'sidecar',
] as const;

/** Hard deadline for the whole diagnose run (spawn + sidecar). */
export const DEFAULT_OVERALL_TIMEOUT_MS = 4_000;
/** Per-binary version probe. */
export const DEFAULT_STAGE_TIMEOUT_MS = 1_500;
/** Single sidecar GET /health attempt (no waitHealthy loop). */
export const DEFAULT_SIDECAR_TIMEOUT_MS = 1_200;

export interface DiagnoseRuntimeMediaOptions {
  overallTimeoutMs?: number;
  stageTimeoutMs?: number;
  sidecarTimeoutMs?: number;
  /** Injected for tests. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests — replaces SidecarClient.getHealth. */
  probeSidecarHealth?: (baseUrl: string, timeoutMs: number) => Promise<{ status?: string }>;
  /** Injected for tests — replaces spawn version probes. */
  probeCommand?: (
    command: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<CommandProbeResult>;
  /** Injected for tests — PATH / absolute binary existence. */
  binaryExists?: (command: string, env: NodeJS.ProcessEnv) => boolean;
}

export type CommandProbeResult =
  | { ok: true; version: string }
  | { ok: false; code: 'binary_missing' | 'timeout' | 'nonzero_exit' | 'error'; message: string };

function sanitizeSnippet(raw: string, max = 120): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, max);
}

function versionFromOutput(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`;
  const line = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return sanitizeSnippet(line || 'unknown');
}

/**
 * Spawn a short version/help probe and kill it on timeout.
 * Failures always resolve within `timeoutMs` (plus a small kill grace).
 */
export function probeCommandVersion(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CommandProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      resolve(result);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err: any) {
      finish({
        ok: false,
        code: 'error',
        message: sanitizeSnippet(err?.message || 'Failed to start probe'),
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4_000) stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        finish({
          ok: false,
          code: 'binary_missing',
          message: `${command} was not found on PATH`,
        });
        return;
      }
      finish({
        ok: false,
        code: 'error',
        message: sanitizeSnippet(err.message || 'Probe failed to start'),
      });
    });

    proc.on('close', (exitCode) => {
      if (timedOut) {
        finish({
          ok: false,
          code: 'timeout',
          message: `${command} did not respond within ${timeoutMs}ms`,
        });
        return;
      }
      if (exitCode === 0) {
        finish({ ok: true, version: versionFromOutput(stdout, stderr) });
        return;
      }
      finish({
        ok: false,
        code: 'nonzero_exit',
        message: sanitizeSnippet(
          versionFromOutput(stdout, stderr) || `${command} exited with code ${exitCode ?? 'unknown'}`,
        ),
      });
    });
  });
}

async function defaultProbeSidecarHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<{ status?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    if (!text) return { status: 'ok' };
    try {
      return JSON.parse(text) as { status?: string };
    } catch {
      return { status: 'ok' };
    }
  } finally {
    clearTimeout(timer);
  }
}

function stageFromCommand(
  id: RuntimeMediaStageId,
  label: string,
  result: CommandProbeResult,
  missingHint: string,
): RuntimeMediaStageResult {
  if (result.ok) {
    return {
      id,
      status: 'ok',
      message: `${label} available`,
      version: result.version,
      code: 'ok',
    };
  }
  if (result.code === 'binary_missing') {
    return {
      id,
      status: 'fail',
      message: missingHint,
      code: 'binary_missing',
    };
  }
  if (result.code === 'timeout') {
    return {
      id,
      status: 'fail',
      message: result.message,
      code: 'timeout',
    };
  }
  return {
    id,
    status: 'fail',
    message: result.message,
    code: result.code,
  };
}

function computeOverall(stages: RuntimeMediaStageResult[]): RuntimeMediaOverall {
  const actionable = stages.filter((s) => s.status !== 'skipped');
  if (actionable.length === 0) return 'fail';
  const failed = actionable.filter((s) => s.status === 'fail');
  if (failed.length === 0) return 'ok';
  if (failed.length === actionable.length) return 'fail';
  return 'partial';
}

function resolveSidecarMode(env: NodeJS.ProcessEnv): {
  mode: RuntimeMediaSidecarMode;
  baseUrl: string;
  binaryPath: string;
} {
  const url = (env.SIDECAR_URL || '').trim();
  const port = Number(env.SIDECAR_PORT) || 9800;
  const binaryPath = (env.SIDECAR_BINARY_PATH || 'sidecar').trim() || 'sidecar';
  if (url) {
    return { mode: 'url', baseUrl: url.replace(/\/+$/, ''), binaryPath };
  }
  return {
    mode: 'local',
    baseUrl: `http://127.0.0.1:${port}`,
    binaryPath,
  };
}

/** True when `command` is an absolute/relative path or resolves on PATH. Never spawns. */
export function binaryExistsOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const name = command.trim();
  if (!name) return false;
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    try {
      accessSync(name, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = env.PATH || '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

async function probeSidecarStage(
  options: Required<Pick<DiagnoseRuntimeMediaOptions, 'sidecarTimeoutMs'>> & {
    env: NodeJS.ProcessEnv;
    probeSidecarHealth: NonNullable<DiagnoseRuntimeMediaOptions['probeSidecarHealth']>;
    binaryExists: NonNullable<DiagnoseRuntimeMediaOptions['binaryExists']>;
    remainingMs: () => number;
  },
): Promise<{ stage: RuntimeMediaStageResult; mode: RuntimeMediaSidecarMode }> {
  const { mode, baseUrl, binaryPath } = resolveSidecarMode(options.env);
  const budget = Math.max(0, Math.min(options.sidecarTimeoutMs, options.remainingMs()));

  if (budget <= 0) {
    return {
      mode,
      stage: {
        id: 'sidecar',
        status: 'fail',
        message: 'Skipped — overall diagnostic deadline reached',
        code: 'timeout',
      },
    };
  }

  if (mode === 'url') {
    try {
      const health = await options.probeSidecarHealth(baseUrl, budget);
      return {
        mode,
        stage: {
          id: 'sidecar',
          status: 'ok',
          message: 'Sidecar health endpoint reachable',
          version: health.status || 'ok',
          code: 'ok',
        },
      };
    } catch (err: any) {
      const timedOut = err?.name === 'AbortError' || /aborted|timeout/i.test(String(err?.message || ''));
      return {
        mode,
        stage: {
          id: 'sidecar',
          status: 'fail',
          message: timedOut
            ? `Sidecar at configured URL did not respond within ${budget}ms`
            : 'Sidecar health check failed — verify SIDECAR_URL and that the sidecar container is running',
          code: timedOut ? 'timeout' : 'sidecar_unreachable',
        },
      };
    }
  }

  // Local mode: never spawn the sidecar here (that would start media). Check PATH only.
  if (!options.binaryExists(binaryPath, options.env)) {
    return {
      mode,
      stage: {
        id: 'sidecar',
        status: 'fail',
        message: 'Sidecar binary was not found — set SIDECAR_BINARY_PATH or use SIDECAR_URL in Docker',
        code: 'binary_missing',
      },
    };
  }

  const healthBudget = Math.max(0, Math.min(options.sidecarTimeoutMs, options.remainingMs()));
  if (healthBudget <= 0) {
    return {
      mode,
      stage: {
        id: 'sidecar',
        status: 'skipped',
        message: 'Sidecar binary present — listening state not checked (deadline reached)',
        code: 'not_listening',
      },
    };
  }

  try {
    const health = await options.probeSidecarHealth(baseUrl, healthBudget);
    return {
      mode,
      stage: {
        id: 'sidecar',
        status: 'ok',
        message: 'Local sidecar is listening',
        version: health.status || 'ok',
        code: 'ok',
      },
    };
  } catch {
    return {
      mode,
      stage: {
        id: 'sidecar',
        status: 'skipped',
        message: 'Sidecar binary present — not listening yet (starts when video streaming begins)',
        code: 'not_listening',
      },
    };
  }
}

/**
 * Run bounded yt-dlp / ffmpeg / ffprobe / sidecar probes.
 * Always settles within overallTimeoutMs (best-effort; individual stages kill on timeout).
 */
export async function diagnoseRuntimeMedia(
  options: DiagnoseRuntimeMediaOptions = {},
): Promise<RuntimeMediaDiagnosticReport> {
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const sidecarTimeoutMs = options.sidecarTimeoutMs ?? DEFAULT_SIDECAR_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const probeCommand = options.probeCommand ?? probeCommandVersion;
  const probeSidecarHealth = options.probeSidecarHealth ?? defaultProbeSidecarHealth;
  const binaryExists = options.binaryExists ?? binaryExistsOnPath;

  const started = Date.now();
  const deadline = started + overallTimeoutMs;
  const remainingMs = () => deadline - Date.now();

  const stages: RuntimeMediaStageResult[] = [];

  const runBinary = async (
    id: RuntimeMediaStageId,
    command: string,
    args: string[],
    label: string,
    missingHint: string,
  ) => {
    const budget = Math.min(stageTimeoutMs, Math.max(0, remainingMs()));
    if (budget <= 0) {
      stages.push({
        id,
        status: 'fail',
        message: 'Skipped — overall diagnostic deadline reached',
        code: 'timeout',
      });
      return;
    }
    const result = await probeCommand(command, args, budget);
    stages.push(stageFromCommand(id, label, result, missingHint));
  };

  await runBinary(
    'yt-dlp',
    'yt-dlp',
    ['--version'],
    'yt-dlp',
    'yt-dlp was not found — pull or rebuild the TS6 Manager image to restore the bundled extractor',
  );
  await runBinary(
    'ffmpeg',
    'ffmpeg',
    ['-version'],
    'ffmpeg',
    'ffmpeg was not found — audio/video decode requires ffmpeg on the backend PATH',
  );
  await runBinary(
    'ffprobe',
    'ffprobe',
    ['-version'],
    'ffprobe',
    'ffprobe was not found — media duration/metadata probes require ffprobe',
  );

  const sidecar = await probeSidecarStage({
    env,
    binaryExists,
    probeSidecarHealth,
    sidecarTimeoutMs,
    remainingMs,
  });
  stages.push(sidecar.stage);

  return {
    checkedAt: new Date().toISOString(),
    overall: computeOverall(stages),
    stages,
    meta: { sidecarMode: sidecar.mode },
  };
}
