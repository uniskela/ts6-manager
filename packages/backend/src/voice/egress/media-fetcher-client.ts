import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { RADIO_EGRESS_PORTS } from './egress-policy.js';
import { MediaEgressError } from './media-egress.js';

/** User-facing message when remote radio cannot use the isolated fetcher. */
export const RADIO_FETCHER_UNAVAILABLE =
  'Radio playback needs the isolated media fetcher. Saved stations are unchanged.';

export const MEDIA_FETCHER_UNAVAILABLE = RADIO_FETCHER_UNAVAILABLE;

/** Bound connect wait for the job socket. */
export const MEDIA_FETCHER_CONNECT_TIMEOUT_MS = 3_000;
/** Bound wait for the submit/header JSON line (before audio). */
export const MEDIA_FETCHER_HEADER_TIMEOUT_MS = 5_000;
/** Bound cancel RPC so Stop cannot hang on a wedged fetcher. */
export const MEDIA_FETCHER_CANCEL_TIMEOUT_MS = 2_000;
/** PassThrough high-water mark — pause the socket when full (backpressure). */
export const MEDIA_FETCHER_STDOUT_HIGH_WATER_MARK = 256 * 1024;

function fetcherUnavailable(): MediaEgressError {
  return new MediaEgressError(RADIO_FETCHER_UNAVAILABLE);
}

function readToken(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.MEDIA_FETCHER_TOKEN_FILE;
  if (!file) throw fetcherUnavailable();
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o007) !== 0) throw new Error('world');
    const token = fs.readFileSync(file, 'utf8').replace(/\s+/g, '');
    if (token.length < 16) throw new Error('short');
    return token;
  } catch (err) {
    if (err instanceof MediaEgressError) throw err;
    throw fetcherUnavailable();
  }
}

export interface FetcherStream {
  stdout: Readable;
  process: ChildProcess;
  kill: () => void;
}

function connectJob(sockPath: string, timeoutMs = MEDIA_FETCHER_CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connect-timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function rpc(
  sockPath: string,
  msg: Record<string, unknown>,
  timeoutMs = MEDIA_FETCHER_CANCEL_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const socket = await connectJob(sockPath, timeoutMs);
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('rpc-timeout'));
    }, timeoutMs);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      socket.end();
      try {
        const parsed = JSON.parse(buf.slice(0, nl));
        finish(() => resolve(parsed));
      } catch (err) {
        finish(() => reject(err));
      }
    });
    socket.on('error', (err) => finish(() => reject(err)));
    socket.write(`${JSON.stringify(msg)}\n`);
  });
}

/**
 * Submit a radio fetch job. Never falls back to local ffmpeg.
 * `process` is a stand-in so existing TeamSpeak radio handlers keep working.
 */
export async function submitMediaFetch(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FetcherStream> {
  const sockPath = env.MEDIA_FETCHER_SOCK || '/jobs/jobs.sock';
  let token: string;
  try {
    token = readToken(env);
  } catch (err) {
    if (err instanceof MediaEgressError) throw err;
    throw fetcherUnavailable();
  }
  let socket: net.Socket;
  try {
    socket = await connectJob(sockPath);
  } catch {
    throw fetcherUnavailable();
  }
  const stdout = new PassThrough({ highWaterMark: MEDIA_FETCHER_STDOUT_HIGH_WATER_MARK });
  const proc = new EventEmitter() as ChildProcess;
  let buf = Buffer.alloc(0);
  let killed = false;
  let jobId = '';
  let paused = false;

  const kill = () => {
    if (killed) return;
    killed = true;
    socket.destroy();
    rpc(sockPath, { op: 'cancel', token, jobId }).catch(() => {});
  };

  const headerTimeoutMs = Number(env.MEDIA_FETCHER_HEADER_TIMEOUT_MS) > 0
    ? Number(env.MEDIA_FETCHER_HEADER_TIMEOUT_MS)
    : MEDIA_FETCHER_HEADER_TIMEOUT_MS;

  let header: Record<string, unknown>;
  try {
    header = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const fail = () => reject(fetcherUnavailable());
      const timer = setTimeout(() => {
        socket.off('data', onHead);
        socket.off('error', fail);
        fail();
      }, headerTimeoutMs);
      function onHead(chunk: Buffer) {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        clearTimeout(timer);
        socket.off('data', onHead);
        socket.off('error', fail);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(buf.subarray(0, nl).toString());
        } catch {
          reject(fetcherUnavailable());
          return;
        }
        buf = buf.subarray(nl + 1);
        resolve(parsed);
      }
      socket.on('error', fail);
      socket.on('data', onHead);
      socket.write(`${JSON.stringify({
        op: 'submit',
        token,
        url,
        ports: [...RADIO_EGRESS_PORTS],
      })}\n`);
    });
  } catch {
    socket.destroy();
    throw fetcherUnavailable();
  }

  if (!header.ok) {
    socket.destroy();
    throw fetcherUnavailable();
  }
  jobId = String(header.jobId ?? '');
  if (buf.length) {
    if (!stdout.write(buf)) {
      paused = true;
      socket.pause();
    }
  }

  const resumeIfDrained = () => {
    if (!paused || killed) return;
    paused = false;
    socket.resume();
  };
  stdout.on('drain', resumeIfDrained);

  socket.on('data', (chunk) => {
    if (killed) return;
    if (!stdout.write(chunk)) {
      paused = true;
      socket.pause();
    }
  });
  socket.on('end', () => {
    stdout.end();
    proc.emit('close', killed ? 1 : 0);
  });
  socket.on('error', (err) => {
    stdout.destroy();
    proc.emit('error', err);
  });
  proc.kill = () => {
    kill();
    return true;
  };
  return { stdout, process: proc, kill };
}
