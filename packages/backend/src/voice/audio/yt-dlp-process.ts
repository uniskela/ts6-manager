import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { acquireMediaEgress, egressEnvironment } from '../egress/media-egress.js';
import { getYtDlpPath } from './yt-dlp-path.js';

/**
 * Options added to every yt-dlp run, ahead of the caller's:
 * - no configuration files or plugins from the host (they could change the
 *   proxy or the downloader); the job's proxy is read from stdin instead,
 *   which also keeps its credentials out of the process list. Deno, which the
 *   images used to enable in a config file, is named here instead;
 * - yt-dlp's own downloader for every protocol, so HTTP, HLS and DASH go
 *   through the proxy rather than an external program;
 * - when yt-dlp still hands a stream to ffmpeg, ffmpeg may open only plain
 *   protocols. Without its proxy-tunnel protocol, https through ffmpeg fails
 *   instead of letting a playlist open connections of its own.
 */
export const YT_DLP_EGRESS_ARGS = [
  '--ignore-config', '--no-plugin-dirs', '--config-locations', '-',
  '--js-runtimes', 'deno',
  '--downloader', 'native',
  '--downloader-args', 'ffmpeg_i:-protocol_whitelist http,https,tls,tcp,crypto',
] as const;

/** Protocols yt-dlp may download with: HTTP(S), HLS and DASH over HTTP. */
const HTTP_ONLY = "[protocol~='^(https?|m3u8(_native)?|http_dash_segments(_generator)?)$']";

/**
 * Add the HTTP-only protocol filter to every format in a `-f` selector
 * (alternatives split by `/`, merged formats by `+`). A source with no
 * HTTP format then fails instead of using RTMP, RTSP or similar.
 */
export function httpOnlyFormat(selector: string): string {
  if (/[(),]/.test(selector)) throw new Error('Unsupported format selector');
  return selector
    .split('/')
    .map((alternative) => alternative.split('+').map((part) => `${part}${HTTP_ONLY}`).join('+'))
    .join('/');
}

/** The caller's arguments with every `-f` selector restricted to HTTP protocols. */
export function withHttpOnlyFormats(args: readonly string[]): string[] {
  // Joined spellings would skip the filter; callers pass `-f <selector>`.
  if (args.some((arg) => /^--format=/.test(arg) || /^-f./.test(arg))) throw new Error('Pass yt-dlp formats as -f <selector>');
  return args.map((arg, i) => (i > 0 && (args[i - 1] === '-f' || args[i - 1] === '--format') ? httpOnlyFormat(arg) : arg));
}

/** What a yt-dlp run fetches: the URL after `--`, or its `ytsearch` query. */
export function ytDlpTarget(args: readonly string[]): string {
  const separator = args.indexOf('--');
  if (separator >= 0 && separator + 2 === args.length) return args[separator + 1];
  if (separator >= 0) throw new Error('yt-dlp takes exactly one URL after --');
  const search = args.find((arg) => /^ytsearch\d*:/.test(arg));
  if (search !== undefined) return search;
  throw new Error('yt-dlp needs a URL after -- or a ytsearch query');
}

export interface YtDlpRun {
  proc: ChildProcessWithoutNullStreams;
  /** Remove the job's proxy credentials from yt-dlp output before it is logged or shown. */
  redact(text: string): string;
}

/**
 * Start yt-dlp for `target` (the URL after `--`, or a `ytsearch` query) with
 * this job's media egress. The job's proxy token is revoked when the process
 * exits. Throws MediaEgressError, without starting yt-dlp, when the proxy
 * cannot be used.
 */
export async function spawnYtDlp(
  args: readonly string[],
  options: { target: string; timeoutMs: number; detached?: boolean },
): Promise<YtDlpRun> {
  // The token outlives the process's own timeout a little, never indefinitely.
  const job = await acquireMediaEgress(options.target, options.timeoutMs + 30_000);
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(getYtDlpPath(), [...YT_DLP_EGRESS_ARGS, ...withHttpOnlyFormats(args)], {
      shell: false,
      detached: options.detached,
      env: job ? egressEnvironment(job.proxyUrl) : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    job?.release();
    throw err;
  }
  const release = () => job?.release();
  proc.once('close', release);
  proc.once('error', release);
  proc.stdin.on('error', () => { /* yt-dlp exited before reading its configuration */ });
  proc.stdin.end(job ? `--proxy ${job.proxyUrl}\n` : '');
  // Output is kept as a tail, which can cut a token: anything shaped like the job proxy is removed too.
  const redact = (text: string) => (job ? job.redact(text) : text).replace(/[0-9a-f]{8,64}@127\.0\.0\.1:\d+/g, '***@127.0.0.1');
  return { proc, redact };
}
