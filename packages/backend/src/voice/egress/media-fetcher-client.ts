import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { RADIO_EGRESS_PORTS } from './egress-policy.js';
import { MEDIA_LINK_UNAVAILABLE, MediaEgressError } from './media-egress.js';

/** MEDIA_FETCHER=1 routes radio through the isolated fetcher. Any other value leaves the in-process path. */
export function mediaFetcherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MEDIA_FETCHER ?? '').trim() === '1';
}

/**
 * Temporary HLS refusal for installs without the isolated fetcher.
 * RADIO_ALLOW_HLS=0 rejects .m3u8 URLs. This does not close the Debian
 * ffmpeg httpproxy SSRF gap for other playlist shapes.
 */
export function radioAllowsHls(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.RADIO_ALLOW_HLS ?? '1').trim() !== '0';
}

export const RADIO_HLS_RESTRICTED =
  'HLS radio is disabled (RADIO_ALLOW_HLS=0) until the isolated media fetcher is enabled. This restriction does not fully resolve SSRF.';

export const MEDIA_FETCHER_UNAVAILABLE = MEDIA_LINK_UNAVAILABLE;

function readToken(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.MEDIA_FETCHER_TOKEN_FILE;
  if (!file) throw new MediaEgressError();
  try {
    const token = fs.readFileSync(file, 'utf8').replace(/\s+/g, '');
    if (token.length < 16) throw new Error('short');
    return token;
  } catch {
    throw new MediaEgressError();
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
    throw new MediaEgressError();
  }
  let socket: net.Socket;
  try {
    socket = await connectJob(sockPath);
  } catch {
    throw new MediaEgressError();
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
    const fail = () => reject(new MediaEgressError());
    socket.on('error', fail);
    socket.on('data', function onHead(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      socket.off('data', onHead);
      socket.off('error', fail);
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(buf.subarray(0, nl).toString()); } catch {
        reject(new MediaEgressError());
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
    throw new MediaEgressError();
  }

  if (!header.ok) {
    socket.destroy();
    throw new MediaEgressError();
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
