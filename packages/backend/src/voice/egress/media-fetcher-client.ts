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

function connectJob(sockPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function rpc(sockPath: string, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = await connectJob(sockPath);
  return new Promise((resolve, reject) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      socket.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (err) { reject(err); }
    });
    socket.on('error', reject);
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
  const stdout = new PassThrough();
  const proc = new EventEmitter() as ChildProcess;
  let buf = Buffer.alloc(0);
  let killed = false;
  let jobId = '';

  const kill = () => {
    if (killed) return;
    killed = true;
    socket.destroy();
    rpc(sockPath, { op: 'cancel', token, jobId }).catch(() => {});
  };

  let header: Record<string, unknown>;
  try {
    header = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const fail = () => reject(fetcherUnavailable());
    socket.on('error', fail);
    socket.on('data', function onHead(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      socket.off('data', onHead);
      socket.off('error', fail);
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(buf.subarray(0, nl).toString()); } catch {
        reject(fetcherUnavailable());
        return;
      }
      buf = buf.subarray(nl + 1);
      resolve(parsed);
    });
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
  if (buf.length) stdout.write(buf);
  socket.on('data', (chunk) => stdout.write(chunk));
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
