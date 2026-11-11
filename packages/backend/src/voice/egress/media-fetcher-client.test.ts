import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { MediaEgressError } from './media-egress.js';
import { RADIO_FETCHER_UNAVAILABLE, submitMediaFetch } from './media-fetcher-client.js';

const saved = {
  flag: process.env.MEDIA_FETCHER,
  sock: process.env.MEDIA_FETCHER_SOCK,
  token: process.env.MEDIA_FETCHER_TOKEN_FILE,
};

afterEach(() => {
  for (const [key, value] of [
    ['MEDIA_FETCHER', saved.flag],
    ['MEDIA_FETCHER_SOCK', saved.sock],
    ['MEDIA_FETCHER_TOKEN_FILE', saved.token],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function isUnavailable(err: unknown): boolean {
  return err instanceof MediaEgressError && err.message === RADIO_FETCHER_UNAVAILABLE;
}

describe('submitMediaFetch', () => {
  it('fails closed with a user message when the token file or job socket is missing', async () => {
    const spawn = mock.method(childProcess, 'spawn', () => {
      throw new Error('must not spawn');
    });
    try {
      await assert.rejects(
        () => submitMediaFetch('https://203.0.113.10/live', {
          MEDIA_FETCHER_SOCK: '/tmp/ts6-missing-jobs.sock',
        }),
        isUnavailable,
      );
      await assert.rejects(
        () => submitMediaFetch('https://203.0.113.10/live', {
          MEDIA_FETCHER: 'legacy',
          MEDIA_FETCHER_SOCK: '/tmp/ts6-missing-jobs.sock',
        }),
        isUnavailable,
      );
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-fetch-'));
      const token = path.join(dir, 'token');
      fs.writeFileSync(token, '0123456789abcdef0123456789abcdef', { mode: 0o600 });
      await assert.rejects(
        () => submitMediaFetch('https://203.0.113.10/live', {
          MEDIA_FETCHER: '0',
          MEDIA_FETCHER_SOCK: path.join(dir, 'missing.sock'),
          MEDIA_FETCHER_TOKEN_FILE: token,
        }),
        isUnavailable,
      );
      fs.rmSync(dir, { recursive: true, force: true });
      assert.equal(spawn.mock.calls.length, 0);
    } finally {
      spawn.mock.restore();
    }
  });

  it('fails closed when the token file is world-readable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-fetch-world-'));
    const token = path.join(dir, 'token');
    fs.writeFileSync(token, '0123456789abcdef0123456789abcdef', { mode: 0o644 });
    fs.chmodSync(token, 0o644);
    const spawn = mock.method(childProcess, 'spawn', () => {
      throw new Error('must not spawn');
    });
    try {
      await assert.rejects(
        () => submitMediaFetch('https://203.0.113.10/live', {
          MEDIA_FETCHER_SOCK: path.join(dir, 'jobs.sock'),
          MEDIA_FETCHER_TOKEN_FILE: token,
        }),
        isUnavailable,
      );
      assert.equal(spawn.mock.calls.length, 0);
    } finally {
      spawn.mock.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams PCM after a successful job header and never starts ffmpeg', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-fetch-ok-'));
    const sockPath = path.join(dir, 'jobs.sock');
    const token = path.join(dir, 'token');
    fs.writeFileSync(token, '0123456789abcdef0123456789abcdef', { mode: 0o600 });
    const server = net.createServer((client) => {
      client.once('data', () => {
        client.write(`${JSON.stringify({ ok: true, jobId: 'j1' })}\n`);
        client.write(Buffer.from('pcm'));
        client.end();
      });
    });
    const spawn = mock.method(childProcess, 'spawn', () => {
      throw new Error('must not spawn');
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(sockPath, resolve);
      server.once('error', reject);
    });
    try {
      const stream = await submitMediaFetch('https://203.0.113.10/live', {
        MEDIA_FETCHER_SOCK: sockPath,
        MEDIA_FETCHER_TOKEN_FILE: token,
      });
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.stdout.on('end', () => resolve());
        stream.stdout.on('error', reject);
      });
      assert.equal(Buffer.concat(chunks).toString(), 'pcm');
      assert.equal(spawn.mock.calls.length, 0);
      // Stand-in process keeps a sink so late emit('error') cannot throw.
      assert.ok(stream.process.listenerCount('error') >= 1);
      assert.doesNotThrow(() => stream.process.emit('error', new Error('late-socket')));
    } finally {
      spawn.mock.restore();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the fetcher refuses the job', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-fetch-no-'));
    const sockPath = path.join(dir, 'jobs.sock');
    const token = path.join(dir, 'token');
    fs.writeFileSync(token, '0123456789abcdef0123456789abcdef', { mode: 0o600 });
    const server = net.createServer((client) => {
      client.once('data', () => {
        client.write(`${JSON.stringify({ ok: false, error: 'denied' })}\n`);
        client.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(sockPath, resolve);
      server.once('error', reject);
    });
    try {
      await assert.rejects(
        () => submitMediaFetch('https://203.0.113.10/live', {
          MEDIA_FETCHER_SOCK: sockPath,
          MEDIA_FETCHER_TOKEN_FILE: token,
        }),
        isUnavailable,
      );
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the job header never arrives (header timeout)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-fetch-hang-'));
    const sockPath = path.join(dir, 'jobs.sock');
    const token = path.join(dir, 'token');
    fs.writeFileSync(token, '0123456789abcdef0123456789abcdef', { mode: 0o600 });
    const server = net.createServer((client) => {
      client.on('data', () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(sockPath, resolve);
      server.once('error', reject);
    });
    try {
      const start = Date.now();
      await assert.rejects(
        () => submitMediaFetch('https://203.0.113.10/live', {
          MEDIA_FETCHER_SOCK: sockPath,
          MEDIA_FETCHER_TOKEN_FILE: token,
          MEDIA_FETCHER_HEADER_TIMEOUT_MS: '40',
        }),
        isUnavailable,
      );
      assert.ok(Date.now() - start < 2_000);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
