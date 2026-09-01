import { Client as SSH2Client } from 'ssh2';
import { fingerprintHostKey, hostKeyMatches } from './ssh-host-key.js';
import { sanitizeTsServerHost, validateTsServerPort } from './validate-ts-host.js';

export interface SshTestOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  hostKeyFingerprint?: string | null;
}

export async function testSshConnection(options: SshTestOptions): Promise<{ ok: true } | { ok: false; error: string }> {
  let host: string;
  let port: number;
  try {
    host = sanitizeTsServerHost(options.host);
    port = validateTsServerPort(options.port, 10022);
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Invalid host or port' };
  }

  const { username, password, hostKeyFingerprint } = options;

  if (!host || !username || !password) {
    return { ok: false, error: 'Host, SSH username, and SSH password are required' };
  }

  return new Promise((resolve) => {
    const ssh = new SSH2Client();
    let settled = false;

    const finish = (result: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ssh.end(); } catch { /* ignore */ }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({ ok: false, error: `SSH test timeout for ${host}:${port}` });
    }, 25000);

    ssh.on('ready', () => {
      clearTimeout(timeout);
      ssh.shell(false, (err, channel) => {
        if (err) {
          finish({ ok: false, error: err.message });
          return;
        }

        let bannerReceived = false;

        const bannerTimeout = setTimeout(() => {
          if (!bannerReceived) {
            finish({ ok: false, error: 'Connected but TeamSpeak ServerQuery banner was not received' });
          }
        }, 10000);

        channel.on('data', (data: Buffer) => {
          const text = data.toString('utf-8');
          if (text.includes('TS3') || text.includes('TeamSpeak')) {
            bannerReceived = true;
            clearTimeout(bannerTimeout);
            finish({ ok: true });
          }
        });

        channel.on('close', () => {
          if (!bannerReceived) {
            clearTimeout(bannerTimeout);
            finish({ ok: false, error: 'SSH channel closed before ServerQuery banner' });
          }
        });
      });
    });

    ssh.on('error', (err: Error) => {
      finish({ ok: false, error: err.message });
    });

    ssh.connect({
      host,
      port: port || 10022,
      username,
      password,
      readyTimeout: 10000,
      hostHash: 'sha256',
      hostVerifier: (key: Buffer) => {
        if (!hostKeyMatches(hostKeyFingerprint, key)) {
          finish({
            ok: false,
            error: `SSH host key mismatch (expected ${hostKeyFingerprint}, got ${fingerprintHostKey(key)})`,
          });
          return false;
        }
        return true;
      },
    });
  });
}
