import { Client as SSH2Client, type ClientChannel } from 'ssh2';
import { EventEmitter } from 'events';
import { parseQueryResponse } from '@ts6/common';
import { TS_EVENT_TYPES } from '@ts6/common';
import crypto from 'crypto';
import { fingerprintHostKey, hostKeyMatches } from '../utils/ssh-host-key.js';

export interface SshQueryClientOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Expected SHA-256 hex fingerprint; null = pin on first connect. */
  hostKeyFingerprint?: string | null;
  onHostKeyPinned?: (fingerprint: string) => void | Promise<void>;
}

interface QueuedCommand {
  command: string;
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  responseLines: string[];
}

export declare interface SshQueryClient {
  on(event: 'ready', listener: () => void): this;
  on(event: 'event', listener: (eventName: string, data: Record<string, string>) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  emit(event: 'ready'): boolean;
  emit(event: 'event', eventName: string, data: Record<string, string>): boolean;
  emit(event: 'error', err: Error): boolean;
  emit(event: 'close'): boolean;
}

const SSH_FLOOD_BASE_COOLDOWN_MS = 60_000;
const SSH_FLOOD_MAX_COOLDOWN_MS = 5 * 60_000;

export function shouldReconnectAfterSshClose(destroyed: boolean, fatalError: boolean): boolean {
  return !destroyed && !fatalError;
}

export function isSshFloodError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return message.includes('ts error 524') || message.includes('client is flooding') || message.includes('flooding');
}

export function sshFloodCooldownMs(strikes: number): number {
  return Math.min(
    SSH_FLOOD_MAX_COOLDOWN_MS,
    SSH_FLOOD_BASE_COOLDOWN_MS * 2 ** Math.min(Math.max(0, strikes - 1), 3),
  );
}

export class SshQueryClient extends EventEmitter {
  private ssh: SSH2Client | null = null;
  private shell: ClientChannel | null = null;
  private commandQueue: QueuedCommand[] = [];
  private currentCommand: QueuedCommand | null = null;
  private responseBuffer: string = '';
  private connected: boolean = false;
  private destroyed: boolean = false;
  private bannerReceived: boolean = false;
  private reconnectAttempt: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private fatalError: boolean = false;
  private readonly nickSuffix = crypto.randomBytes(3).toString('hex');
  private reconnecting: boolean = false;
  private floodPauseUntil: number = 0;
  private floodStrikes: number = 0;
  private floodDisconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private options: SshQueryClientOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.destroyed) return;

    return new Promise<void>((resolve, reject) => {
      // Capture locally: if destroy() clears this.ssh while connect is in flight,
      // callbacks must not operate on a replaced/null instance.
      const ssh = new SSH2Client();
      this.ssh = ssh;
      let settled = false;

      // Timeout for the entire connect+banner sequence
      const connectTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          const err = new Error(`SSH connect timeout for ${this.options.host}:${this.options.port}`);
          console.error(`[SshQueryClient] ${err.message}`);
          this.emit('error', err);
          reject(err);
          try { ssh.end(); } catch { }
        }
      }, 15000);

      ssh.on('ready', () => {
        if (this.destroyed) { try { ssh.end(); } catch { } return; }
        ssh.shell(false, (err, channel) => {
          if (err) {
            if (!settled) { settled = true; clearTimeout(connectTimeout); reject(err); }
            this.emit('error', err);
            return;
          }
          if (this.destroyed) { try { channel.close(); } catch { } try { ssh.end(); } catch { } return; }

          this.shell = channel;
          this.responseBuffer = '';
          this.bannerReceived = false;

          channel.on('data', (data: Buffer) => {
            this.onShellData(data);
            // Check if banner has been received after processing data
            if (!this.connected && this.bannerReceived) {
              if (this.destroyed) { try { channel.close(); } catch { } try { ssh.end(); } catch { } return; }
              this.connected = true;
              this.reconnectAttempt = 0;
              this.reconnecting = false;
              this.startKeepalive();
              this.emit('ready');
              if (!settled) { settled = true; clearTimeout(connectTimeout); resolve(); }
            }
          });

          channel.on('close', () => {
            this.connected = false;
            this.bannerReceived = false;
            this.rejectAllPending('SSH channel closed');
            if (!this.destroyed) {
              this.emit('close');
              this.scheduleReconnect();
            }
          });

          channel.stderr.on('data', (data: Buffer) => {
            console.error(`[SshQueryClient] stderr: ${data.toString('utf-8')}`);
          });
        });
      });

      ssh.on('error', (err: Error) => {
        const isAuthError = err.message.includes('authentication') || err.message.includes('Auth');
        if (isAuthError) {
          this.fatalError = true;
          console.error(`[SshQueryClient] Fatal auth error for ${this.options.host}:${this.options.port}: ${err.message}`);
        }
        this.emit('error', err);
        if (!settled) {
          settled = true;
          clearTimeout(connectTimeout);
          reject(err);
        }
      });

      ssh.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.bannerReceived = false;
        this.stopKeepalive();
        this.rejectAllPending('SSH connection closed');
        if (!this.destroyed && wasConnected) {
          this.emit('close');
        }
        if (shouldReconnectAfterSshClose(this.destroyed, this.fatalError)) {
          this.scheduleReconnect();
        }
      });

      ssh.connect({
        host: this.options.host,
        port: this.options.port,
        username: this.options.username,
        password: this.options.password,
        keepaliveInterval: 30000,
        keepaliveCountMax: 3,
        readyTimeout: 10000,
        hostHash: 'sha256',
        hostVerifier: (key: Buffer) => {
          const fp = fingerprintHostKey(key);
          if (!hostKeyMatches(this.options.hostKeyFingerprint, key)) {
            const err = new Error(
              `SSH host key mismatch for ${this.options.host}: expected ${this.options.hostKeyFingerprint}, got ${fp}`,
            );
            this.fatalError = true;
            this.emit('error', err);
            return false;
          }
          if (!this.options.hostKeyFingerprint && this.options.onHostKeyPinned) {
            void Promise.resolve(this.options.onHostKeyPinned(fp)).then(() => {
              this.options.hostKeyFingerprint = fp;
            }).catch((e) => {
              console.error(`[SshQueryClient] Failed to persist host key fingerprint: ${e.message}`);
            });
          }
          return true;
        },
      });
    });
  }

  async executeCommand(command: string, timeoutMs: number = 10000): Promise<string> {
    if (!this.connected || !this.shell) {
      throw new Error('SSH not connected');
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.currentCommand === entry) {
          this.currentCommand = null;
          this.processQueue();
        } else {
          const idx = this.commandQueue.indexOf(entry);
          if (idx !== -1) this.commandQueue.splice(idx, 1);
        }
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      const entry: QueuedCommand = {
        command,
        resolve,
        reject,
        timeout,
        responseLines: [],
      };

      this.commandQueue.push(entry);
      if (!this.currentCommand) {
        this.processQueue();
      }
    });
  }

  async registerEvents(sid: number): Promise<void> {
    if (this.destroyed) return;
    console.log(`[SshQueryClient] Registering events for sid=${sid} on ${this.options.host}`);
    await this.executeCommand(`use sid=${sid}`);

    // Set nickname so the bot is identifiable, and mark as query client type
    try {
      await this.executeCommand(`clientupdate client_nickname=TS6-WebUI-Bot-${sid}-${this.nickSuffix}`);
    } catch { }

    for (const eventType of TS_EVENT_TYPES) {
      const cmd = eventType === 'channel'
        ? `servernotifyregister event=${eventType} id=0`
        : `servernotifyregister event=${eventType}`;
      try {
        await this.executeCommand(cmd);
      } catch (err: any) {
        // error id=516 = already registered, ignore
        if (!err.message?.includes('516')) {
          console.warn(`[SshQueryClient] Failed to register event ${eventType}: ${err.message}`);
        }
      }
    }

    console.log(`[SshQueryClient] Events registered for sid=${sid}`);
  }

  async registerCommandListener(sid: number, channelId: number): Promise<void> {
    if (this.destroyed) return;
    console.log(`[SshQueryClient] Registering command listener for sid=${sid}, channelId=${channelId} on ${this.options.host}`);

    await this.executeCommand(`use sid=${sid}`);

   
    try {
      await this.executeCommand(`clientupdate client_nickname=TS6-WebUI-Cmd-${channelId}-${this.nickSuffix}`);
    } catch (err: any) {
      if (String(err.message || '').toLowerCase().includes('nickname')) {
        const extra = crypto.randomBytes(2).toString('hex');
        try {
          await this.executeCommand(`clientupdate client_nickname=TS6-WebUI-Cmd-${channelId}-${this.nickSuffix}-${extra}`);
        } catch { }
      }
    }

    // Move query client into the channel (required for channel chat notifications)
    try {
      const who = await this.executeCommand('whoami');
      const first = (who.split('\n')[0] || '').trim();
      const me = parseQueryResponse(first)[0] || {};
      const clid =
        me.clid ??
        me.client_id ??
        me.clientid ??
        me.clientId ??
        (() => {
          const m = first.match(/(?:clid|client_id)=(\d+)/);
          return m?.[1];
        })();

      if (clid) {
        await this.executeCommand(`clientmove clid=${clid} cid=${channelId}`);
      } else {
        console.warn('[SshQueryClient] whoami did not return clid; cannot clientmove');
      }
    } catch (err: any) {
      console.warn(`[SshQueryClient] Failed to move query client to channel ${channelId}: ${err.message}`);
    }

    // Register ONLY textchannel for this channel
    try {
      await this.executeCommand(`servernotifyregister event=textchannel id=${channelId}`);
    } catch (err: any) {
      if (!err.message?.includes('516')) {
        console.warn(`[SshQueryClient] Failed to register textchannel for channel ${channelId}: ${err.message}`);
      }
    }

    console.log(`[SshQueryClient] Command listener ready for sid=${sid}, channelId=${channelId}`);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get hasFatalError(): boolean {
    return this.fatalError;
  }

  /**
   * Close the SSH connection and wait for the underlying socket to finish
   * tearing down (ssh2 'close'), up to a short safety timeout. `ssh.end()`
   * only starts async teardown — callers that exit without awaiting can leave
   * a still-registered query session on the TS server (nickname-in-use / already
   * member of channel on fast container restart).
   */
  destroy(): Promise<void> {
    this.destroyed = true;
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.floodDisconnectTimer) {
      clearTimeout(this.floodDisconnectTimer);
      this.floodDisconnectTimer = null;
    }
    this.rejectAllPending('Client destroyed');
    if (this.shell) {
      try { this.shell.close(); } catch { /* ignore */ }
      this.shell = null;
    }
    this.connected = false;

    const ssh = this.ssh;
    this.ssh = null;
    if (!ssh) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(safety);
        resolve();
      };
      const safety = setTimeout(done, 2000);
      safety.unref?.();
      ssh.once('close', done);
      try { ssh.end(); } catch { done(); }
    });
  }

  private forceDisconnect(): void {
    this.connected = false;
    this.bannerReceived = false;
    this.stopKeepalive();
    this.rejectAllPending('Keepalive timeout');
    if (this.shell) {
      try { this.shell.close(); } catch {}
      this.shell = null;
    }
    if (this.ssh) {
      try { this.ssh.end(); } catch {}
      this.ssh = null;
    }
    if (!this.destroyed) {
      this.emit('close');
      this.scheduleReconnect();
    }
  }

  // --- Internals ---

  private enterFloodCooldown(): void {
    this.floodStrikes += 1;
    const cooldownMs = sshFloodCooldownMs(this.floodStrikes);
    this.floodPauseUntil = Date.now() + cooldownMs;
    console.warn(
      `[SshQueryClient] TeamSpeak Query flood protection active for ${this.options.host}:${this.options.port}; pausing reconnect for ${Math.ceil(cooldownMs / 1000)}s (strike ${this.floodStrikes})`,
    );

    // Stop this Query session immediately, but let scheduleReconnect honour the
    // cooldown instead of retrying at 1s/2s/4s while TeamSpeak is still blocking it.
    if (!this.floodDisconnectTimer) {
      this.floodDisconnectTimer = setTimeout(() => {
        this.floodDisconnectTimer = null;
        if (!this.destroyed) this.forceDisconnect();
      }, 0);
    }
  }

  private onShellData(data: Buffer): void {
    this.responseBuffer += data.toString('utf-8');
    const lines = this.responseBuffer.split(/\r?\n/);
    // Keep the last (possibly incomplete) line in the buffer
    this.responseBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Wait for banner before processing commands
      if (!this.bannerReceived) {
        // TS SSH banner: "TS3" followed by "Welcome to the TeamSpeak ServerQuery interface..."
        // Some versions also send "virtualserver_status=..." + "error id=0 msg=ok" after Welcome.
        // We mark the banner as complete once we see the Welcome line, since commands can be
        // sent immediately after it. Any trailing status/error lines are consumed below.
        if (trimmed === 'TS3' || trimmed.includes('TS3 Client')) {
          continue;
        }
        if (trimmed.startsWith('Welcome')) {
          this.bannerReceived = true;
          continue;
        }
        // Consume any other banner lines (e.g., virtualserver_status=, error id=0)
        if (trimmed.startsWith('virtualserver_status=') || trimmed.startsWith('error id=0')) {
          continue;
        }
        continue;
      }

      // Notify events start with "notify"
      if (trimmed.startsWith('notify')) {
        this.handleNotifyLine(trimmed);
        continue;
      }

      // Error line terminates a command response
      if (trimmed.startsWith('error ')) {
        this.handleErrorLine(trimmed);
        continue;
      }

      // Regular response data line — accumulate for current command
      if (this.currentCommand) {
        this.currentCommand.responseLines.push(trimmed);
      }
    }
  }

  private handleNotifyLine(line: string): void {
    // Extract event name (everything before first space)
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) {
      this.emit('event', line, {});
      return;
    }

    const eventName = line.substring(0, spaceIdx);
    const dataStr = line.substring(spaceIdx + 1);

    try {
      const entries = parseQueryResponse(dataStr);
      // Emit once per pipe-separated entry (usually just one for events)
      for (const entry of entries) {
        this.emit('event', eventName, entry);
      }
    } catch {
      this.emit('event', eventName, {});
    }
  }

  private handleErrorLine(line: string): void {
    if (!this.currentCommand) return;

    const cmd = this.currentCommand;
    clearTimeout(cmd.timeout);
    this.currentCommand = null;

    // Parse "error id=N msg=..."
    const parsed = parseQueryResponse(line.substring(6))[0] || {};
    const errorId = parseInt(parsed.id || '0');

    if (errorId === 0) {
      // A successful command after the cooldown proves the Query session is usable again.
      if (Date.now() >= this.floodPauseUntil) {
        this.floodPauseUntil = 0;
        this.floodStrikes = 0;
      }
      cmd.resolve(cmd.responseLines.join('\n'));
      this.processQueue();
      return;
    }

    // 770 = already member of channel — clientmove no-op success (listener already there).
    if (errorId === 770 && /^\s*clientmove\b/i.test(cmd.command)) {
      cmd.resolve(cmd.responseLines.join('\n'));
      this.processQueue();
      return;
    }

    const error = new Error(`TS error ${errorId}: ${parsed.msg || 'Unknown error'}`);
    cmd.reject(error);

    if (errorId === 524 || isSshFloodError(error)) {
      this.enterFloodCooldown();
      return;
    }

    this.processQueue();
  }

  private processQueue(): void {
    if (this.currentCommand || this.commandQueue.length === 0) return;
    if (!this.shell || !this.connected) return;

    this.currentCommand = this.commandQueue.shift()!;
    this.currentCommand.responseLines = [];
    this.shell.write(this.currentCommand.command + '\n');
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    let consecutiveFailures = 0;
    this.keepaliveTimer = setInterval(() => {
      if (this.connected) {
        this.executeCommand('whoami', 5000)
          .then(() => { consecutiveFailures = 0; })
          .catch((err) => {
            if (isSshFloodError(err)) {
              console.warn(
                `[SshQueryClient] TeamSpeak flood protection rejected keepalive for ${this.options.host}:${this.options.port}; reconnect will wait for cooldown`,
              );
              return;
            }

            consecutiveFailures++;
            console.warn(`[SshQueryClient] Keepalive failed for ${this.options.host}:${this.options.port} (${consecutiveFailures}/3): ${err.message}`);
            if (consecutiveFailures >= 3) {
              console.error(`[SshQueryClient] Keepalive failed 3 times, forcing disconnect for ${this.options.host}:${this.options.port}`);
              this.forceDisconnect();
            }
          });
      }
    }, 30000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.fatalError || this.reconnecting) return;
    this.reconnecting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const reconnectBackoff = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
    const floodCooldown = Math.max(0, this.floodPauseUntil - Date.now());
    const delay = Math.max(reconnectBackoff, floodCooldown);
    const reason = floodCooldown > reconnectBackoff ? ' after TeamSpeak flood cooldown' : '';
    console.log(`[SshQueryClient] Reconnecting to ${this.options.host}:${this.options.port} in ${delay}ms${reason} (attempt ${this.reconnectAttempt + 1})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempt++;
      this.reconnecting = false;
      try {
        await this.connect();
      } catch (err: any) {
        console.error(`[SshQueryClient] Reconnect failed: ${err.message}`);
        // connect() failure will trigger another reconnect via the error/close handlers
      }
    }, delay);
  }

  private rejectAllPending(reason: string): void {
    if (this.currentCommand) {
      clearTimeout(this.currentCommand.timeout);
      this.currentCommand.reject(new Error(reason));
      this.currentCommand = null;
    }
    for (const cmd of this.commandQueue) {
      clearTimeout(cmd.timeout);
      cmd.reject(new Error(reason));
    }
    this.commandQueue = [];
  }
}
