/**
 * Bounded ffprobe of a stream source's video resolution, used only by Auto
 * quality. Fixed presets never call this (some IPTV services allow a single
 * connection, and a probe is a second one).
 */

import { spawn } from 'child_process';
import type { SourceResolution } from './quality.js';

export const SOURCE_PROBE_TIMEOUT_MS = 10_000;

export type ProbeRunner = (args: string[], timeoutMs: number) => Promise<string | null>;

function runFfprobe(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('ffprobe', args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 16_000) stdout += chunk.toString();
    });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => finish(code === 0 ? stdout : null));
  });
}

export function sourceProbeArgs(source: string): string[] {
  const args = ['-v', 'error'];
  if (/^https?:\/\//i.test(source)) {
    // Microseconds; bounds each network read so a dead source cannot hang the probe.
    args.push('-rw_timeout', '8000000');
  }
  args.push(
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    source,
  );
  return args;
}

export interface SourceProbe {
  resolution: SourceResolution | null;
  /** Finite duration in seconds; null for live sources (ffprobe reports none). */
  durationSec: number | null;
}

export function parseProbe(stdout: string | null): SourceProbe | null {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
    const duration = Number(parsed.format?.duration);
    return {
      resolution: parseProbeResolution(stdout),
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  } catch {
    return null;
  }
}

/** One bounded ffprobe for Auto quality and live/VOD detection; null on failure. */
export async function probeSource(
  source: string,
  run: ProbeRunner = runFfprobe,
  timeoutMs: number = SOURCE_PROBE_TIMEOUT_MS,
): Promise<SourceProbe | null> {
  if (!source || source.startsWith('-')) return null;
  return parseProbe(await run(sourceProbeArgs(source), timeoutMs));
}

export function parseProbeResolution(stdout: string | null): SourceResolution | null {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
    const s = parsed.streams?.[0];
    const width = Number(s?.width);
    const height = Number(s?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** Probe the first video stream's resolution; null on any failure or timeout. */
export async function probeSourceResolution(
  source: string,
  run: ProbeRunner = runFfprobe,
  timeoutMs: number = SOURCE_PROBE_TIMEOUT_MS,
): Promise<SourceResolution | null> {
  if (!source || source.startsWith('-')) return null;
  return parseProbeResolution(await run(sourceProbeArgs(source), timeoutMs));
}
