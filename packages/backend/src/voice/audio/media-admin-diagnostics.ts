/**
 * Admin media diagnostics (#300).
 *
 * Reuses diagnoseRuntimeMedia plus the sidecar's existing GET /health and
 * GET /encoders. Those HTTP contracts stay as shipped — native-sidecar T06
 * owns changes. `version` is copied only when health already sends it.
 *
 * No installs, no URL playback, no refresh of encoder test encodes.
 */

import type {
  MediaAdminDiagnosticReport,
  MediaDiagnosticCheck,
  MediaDiagnosticEncoders,
  MediaDiagnosticSidecar,
  MediaDiagnosticStatus,
  RuntimeMediaStageResult,
  VideoEncoderCapabilities,
} from '@ts6/common';
import { redactDiagnosticValue } from '@ts6/common';
import OpusScript from 'opusscript';
import { SidecarClient } from '../streaming/sidecar-client.js';
import { BYTES_PER_FRAME, CHANNELS, FRAME_SIZE, SAMPLE_RATE } from './pipeline.js';
import { getYtDlpPath } from './yt-dlp-path.js';
import {
  diagnoseRuntimeMedia,
  probeCommandVersion,
  resolveBinaryOnPath,
  type CommandProbeResult,
  type DiagnoseRuntimeMediaOptions,
} from './runtime-media-diagnostics.js';

export const MEDIA_ADMIN_TIMEOUT_MS = 8_000;
const SMOKE_TIMEOUT_MS = 2_000;
const TOOL_TIMEOUT_MS = 1_500;
const ENCODER_WAIT_MS = 2_500;

const IMAGE_REMEDIATION =
  'Pull or rebuild the TS6 Manager image. Diagnostics do not install binaries into a running container.';

const FFMPEG_SMOKE_ARGS = [
  '-hide_banner',
  '-nostdin',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'anullsrc=r=48000:cl=stereo',
  '-t',
  '0.05',
  '-acodec',
  'pcm_s16le',
  '-ar',
  '48000',
  '-ac',
  '2',
  '-f',
  'null',
  '-',
];

export interface SidecarHealthBody {
  status?: string;
  version?: string;
  videoPort?: number;
  audioPort?: number;
}

export interface DiagnoseMediaAdminOptions extends DiagnoseRuntimeMediaOptions {
  probeOpus?: () => { ok: true } | { ok: false; message: string };
  /** Cached GET /encoders only. Callers must not pass refresh. */
  loadEncoders?: (timeoutMs: number) => Promise<VideoEncoderCapabilities>;
}

export function probeMusicOpus(): { ok: true } | { ok: false; message: string } {
  try {
    const encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    try {
      const encoded = encoder.encode(Buffer.alloc(BYTES_PER_FRAME), FRAME_SIZE);
      if (!encoded?.length) return { ok: false, message: 'Opus encoder returned an empty frame' };
      return { ok: true };
    } finally {
      if (typeof encoder.delete === 'function') encoder.delete();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Opus encoder failed';
    return { ok: false, message: clip(message, 160) };
  }
}

function pickHealth(raw: unknown): SidecarHealthBody {
  if (!raw || typeof raw !== 'object') return {};
  const body = raw as Record<string, unknown>;
  const out: SidecarHealthBody = {};
  if (typeof body.status === 'string') out.status = clip(body.status, 80);
  if (typeof body.version === 'string') out.version = clip(body.version, 80);
  if (typeof body.videoPort === 'number' && Number.isFinite(body.videoPort)) out.videoPort = body.videoPort;
  if (typeof body.audioPort === 'number' && Number.isFinite(body.audioPort)) out.audioPort = body.audioPort;
  return out;
}

async function fetchSidecarHealth(baseUrl: string, timeoutMs: number): Promise<SidecarHealthBody> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = pickHealth(await res.json());
    if (!body.status) throw new Error('Invalid sidecar health response');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function clip(value: string, max = 180): string {
  const flat = redactDiagnosticValue(value).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function stageCheck(
  stage: RuntimeMediaStageResult | undefined,
  label: string,
  remediation: string,
): MediaDiagnosticCheck {
  if (!stage) {
    return { id: label, label, status: 'fail', message: 'Not reported', remediation };
  }
  const status: MediaDiagnosticStatus = stage.status === 'skipped' ? 'warning' : stage.status;
  return {
    id: stage.id,
    label,
    status,
    message: clip(stage.message),
    ...(stage.version ? { version: clip(stage.version, 120) } : {}),
    ...(status === 'fail' ? { remediation } : {}),
  };
}

function checkFromProbe(
  id: string,
  label: string,
  result: CommandProbeResult | undefined,
  okMessage: string,
  remediation: string,
): MediaDiagnosticCheck {
  if (!result) {
    return skipped(id, label, 'Skipped — overall diagnostic deadline reached');
  }
  if (result.ok) {
    return {
      id,
      label,
      status: 'ok',
      message: okMessage,
      ...(result.version && result.version !== 'unknown' ? { version: clip(result.version, 120) } : {}),
    };
  }
  return {
    id,
    label,
    status: 'fail',
    message: clip(result.message),
    remediation,
  };
}

function skipped(id: string, label: string, message: string): MediaDiagnosticCheck {
  return { id, label, status: 'skipped', message };
}

async function boundedProbe(
  remainingMs: () => number,
  timeoutMs: number,
  probe: DiagnoseRuntimeMediaOptions['probeCommand'],
  command: string,
  args: string[],
): Promise<CommandProbeResult | undefined> {
  const run = probe ?? probeCommandVersion;
  const budget = Math.min(timeoutMs, Math.max(0, remainingMs()));
  if (budget < 200) {
    return undefined;
  }
  return run(command, args, budget);
}

function encoderSummary(caps: VideoEncoderCapabilities): MediaDiagnosticEncoders {
  const items = caps.encoders.map((encoder) => ({
    id: encoder.id,
    codec: encoder.codec,
    hardware: encoder.hardware,
    available: encoder.available,
    ...(!encoder.available && (encoder.error || encoder.skipped)
      ? { detail: clip(encoder.error || encoder.skipped || '', 160) }
      : {}),
  }));
  const software = items.filter((item) => !item.hardware);
  const softwareOk = software.some((item) => item.available);
  return {
    status: softwareOk ? 'ok' : 'warning',
    message: softwareOk
      ? 'Sidecar reported encoder capabilities (cached GET /encoders; hardware rows can be unavailable without a GPU).'
      : 'Sidecar answered, but no software encoder is available.',
    checkedAt: caps.checkedAt,
    items,
  };
}

function overallOf(report: Pick<MediaAdminDiagnosticReport, 'checks' | 'sidecar' | 'encoders'>): MediaAdminDiagnosticReport['overall'] {
  const statuses = [
    ...report.checks.map((check) => check.status),
    report.sidecar.status,
    report.encoders.status,
  ].filter((status) => status !== 'skipped');
  if (statuses.length === 0) return 'fail';
  if (statuses.every((status) => status === 'fail')) return 'fail';
  if (statuses.some((status) => status === 'fail' || status === 'warning')) return 'partial';
  return 'ok';
}

function warningsOf(report: Pick<MediaAdminDiagnosticReport, 'checks' | 'sidecar' | 'encoders'>): string[] {
  const lines: string[] = [];
  for (const check of report.checks) {
    if (check.status !== 'warning' && check.status !== 'fail') continue;
    lines.push(check.remediation ? `${check.label}: ${check.message} ${check.remediation}` : `${check.label}: ${check.message}`);
  }
  if (report.sidecar.status === 'warning' || report.sidecar.status === 'fail') {
    lines.push(report.sidecar.message);
  }
  if (report.encoders.status === 'warning' || report.encoders.status === 'fail') {
    lines.push(report.encoders.message);
  }
  return lines;
}

async function defaultLoadEncoders(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<VideoEncoderCapabilities> {
  const url = (env.SIDECAR_URL || '').trim();
  const client = new SidecarClient(url || Number(env.SIDECAR_PORT) || 9800, env.SIDECAR_SECRET);
  return client.getEncoders(false, timeoutMs);
}

function sidecarSummary(
  stage: RuntimeMediaStageResult | undefined,
  mode: MediaDiagnosticSidecar['mode'],
  health?: SidecarHealthBody,
): MediaDiagnosticSidecar {
  let status: MediaDiagnosticStatus = 'fail';
  if (stage?.status === 'ok') status = 'ok';
  if (stage?.code === 'version_mismatch' || stage?.status === 'skipped') status = 'warning';
  return {
    mode,
    status,
    message: clip(stage?.message || 'Sidecar was not checked'),
    ...(health?.version ? { version: health.version } : {}),
    ...(health?.status ? { healthStatus: health.status } : {}),
    ...(health?.videoPort != null ? { videoPort: health.videoPort } : {}),
    ...(health?.audioPort != null ? { audioPort: health.audioPort } : {}),
  };
}

async function loadEncoderReport(
  sidecarHealthy: boolean,
  remainingMs: () => number,
  load: NonNullable<DiagnoseMediaAdminOptions['loadEncoders']>,
): Promise<MediaDiagnosticEncoders> {
  if (!sidecarHealthy) {
    return {
      status: 'warning',
      message: 'Encoder capabilities were not loaded because the sidecar health check did not succeed. GET /encoders was not called.',
      items: [],
    };
  }
  const budget = Math.min(ENCODER_WAIT_MS, Math.max(0, remainingMs()));
  if (budget < 200) {
    return {
      status: 'warning',
      message: 'Skipped encoder capabilities — overall diagnostic deadline reached.',
      items: [],
    };
  }
  try {
    return encoderSummary(await load(budget));
  } catch {
    return {
      status: 'warning',
      message: 'Encoder capabilities did not answer within the diagnostic budget. Use Check encoders on Streaming defaults.',
      items: [],
    };
  }
}

export async function diagnoseMediaAdmin(
  options: DiagnoseMediaAdminOptions = {},
): Promise<MediaAdminDiagnosticReport> {
  const overallTimeoutMs = options.overallTimeoutMs ?? MEDIA_ADMIN_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const started = Date.now();
  const deadline = started + overallTimeoutMs;
  const remainingMs = () => deadline - Date.now();

  let healthBody: SidecarHealthBody | undefined;
  const probeSidecarHealth = async (baseUrl: string, timeoutMs: number) => {
    const raw = options.probeSidecarHealth
      ? await options.probeSidecarHealth(baseUrl, timeoutMs)
      : await fetchSidecarHealth(baseUrl, timeoutMs);
    healthBody = pickHealth(raw);
    if (healthBody.status && !['ok', 'healthy'].includes(healthBody.status)) {
      throw new Error('Sidecar reported an unhealthy status');
    }
    return healthBody;
  };

  const runtimeBudget = Math.min(4_000, Math.max(0, remainingMs()));
  const runtime = await diagnoseRuntimeMedia({
    ...options,
    env,
    overallTimeoutMs: runtimeBudget,
    probeSidecarHealth,
  });
  const stage = (id: RuntimeMediaStageResult['id']) => runtime.stages.find((item) => item.id === id);

  const checks: MediaDiagnosticCheck[] = [
    stageCheck(stage('ffmpeg'), 'FFmpeg', `Verify ffmpeg is executable on the backend PATH. ${IMAGE_REMEDIATION}`),
    stageCheck(stage('ffprobe'), 'ffprobe', `Verify ffprobe is executable on the backend PATH. ${IMAGE_REMEDIATION}`),
  ];

  const ffmpegOk = stage('ffmpeg')?.status === 'ok';
  if (!ffmpegOk) {
    checks.push(skipped('ffmpeg-smoke', 'FFmpeg smoke', 'Skipped because ffmpeg is not available.'));
  } else {
    const smoke = await boundedProbe(
      remainingMs,
      SMOKE_TIMEOUT_MS,
      options.probeCommand,
      'ffmpeg',
      FFMPEG_SMOKE_ARGS,
    );
    checks.push(checkFromProbe(
      'ffmpeg-smoke',
      'FFmpeg smoke',
      smoke,
      'Decoded a short synthetic input to PCM and discarded it. No file or network output.',
      'The music decode path could not run a bounded lavfi smoke. Pull or rebuild an image whose ffmpeg includes the lavfi demuxer.',
    ));
  }

  const probeOpus = options.probeOpus ?? probeMusicOpus;
  const opus = probeOpus();
  checks.push(
    opus.ok
      ? { id: 'opus', label: 'Opus', status: 'ok', message: 'In-process Opus encoder produced a silent frame (same settings as music playback).' }
      : {
        id: 'opus',
        label: 'Opus',
        status: 'fail',
        message: clip(opus.message),
        remediation: 'Music playback needs the bundled Opus encoder. Pull or rebuild the image.',
      },
    stageCheck(
      stage('yt-dlp'),
      'yt-dlp',
      `Verify YT_DLP_PATH points to a trusted executable. ${IMAGE_REMEDIATION}`,
    ),
  );

  const ytOk = stage('yt-dlp')?.status === 'ok';
  if (!ytOk) {
    checks.push(skipped('yt-dlp-extractors', 'yt-dlp extractors', 'Skipped because yt-dlp is not available.'));
  } else {
    const listed = await boundedProbe(
      remainingMs,
      SMOKE_TIMEOUT_MS,
      options.probeCommand,
      getYtDlpPath(env),
      ['--ignore-config', '--list-extractors'],
    );
    checks.push(checkFromProbe(
      'yt-dlp-extractors',
      'yt-dlp extractors',
      listed,
      'yt-dlp listed extractors locally. No URL was fetched and no cookies were read into the report.',
      'yt-dlp could not list its extractors. Pull or rebuild the image; do not self-update yt-dlp inside a container.',
    ));
  }

  const denoProbe = await boundedProbe(
    remainingMs,
    TOOL_TIMEOUT_MS,
    options.probeCommand,
    'deno',
    ['--version'],
  );
  const denoCheck = checkFromProbe(
    'deno',
    'Deno',
    denoProbe,
    'Deno is available for yt-dlp YouTube challenge solving (--js-runtimes deno).',
    `Deno could not run. YouTube playback can fail the n challenge. ${IMAGE_REMEDIATION}`,
  );
  if (denoProbe && !denoProbe.ok && denoProbe.code === 'binary_missing') denoCheck.status = 'warning';
  checks.push(denoCheck);

  const tools: Record<string, string> = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', deno: 'deno' };
  if (stage('yt-dlp')?.code !== 'misconfigured') tools['yt-dlp'] = getYtDlpPath(env);
  for (const check of checks) {
    const command = tools[check.id];
    if (command) check.path = resolveBinaryOnPath(command, env) ?? command;
  }

  const sidecarStage = stage('sidecar');
  const sidecar = sidecarSummary(sidecarStage, runtime.meta.sidecarMode, healthBody);
  const encoders = await loadEncoderReport(
    sidecarStage?.status === 'ok',
    remainingMs,
    options.loadEncoders ?? ((timeoutMs) => defaultLoadEncoders(env, timeoutMs)),
  );

  const draft: MediaAdminDiagnosticReport = {
    checkedAt: new Date().toISOString(),
    overall: 'ok',
    checks,
    sidecar,
    encoders,
    warnings: [] as string[],
  };
  draft.overall = overallOf(draft);
  draft.warnings = warningsOf(draft);
  return redactDiagnosticValue(draft);
}
