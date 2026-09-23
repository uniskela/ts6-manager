import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import {
  AppError,
  TeamSpeakFloodError,
  TeamSpeakUnavailableError,
  TSApiError,
} from '../middleware/error-handler.js';
import { config } from '../config.js';
import type { ValidatedTsServerEndpoint } from '../utils/validate-ts-host.js';
import { createValidatedTsServerEndpoint, isAllowedTsServerHost, buildWebQueryPath } from '../utils/validate-ts-host.js';
import {
  diagnoseConnection as runDiagnoseConnection,
  type ConnectionDiagnosticReport,
  type DiagnoseConnectionOptions,
} from './connection-diagnostics.js';

/** UI / interactive traffic jumps ahead of background bots & animations. */
export type WebQueryPriority = 'high' | 'normal' | 'low';

const PRIORITY_RANK: Record<WebQueryPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

/** Minimum gap between WebQuery commands — TS flood protection trips without this. */
const MIN_COMMAND_GAP_MS = 350;
const FLOOD_BASE_PAUSE_MS = 60_000;
const FLOOD_MAX_PAUSE_MS = 5 * 60_000;

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

/** Transport-level Query failures while TeamSpeak is still booting or resetting sockets. */
export function isTransientNetworkError(error: any): boolean {
  if (error instanceof TeamSpeakUnavailableError) return true;
  const code = error?.code || error?.cause?.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = String(error?.message || error?.details || '');
  return (
    msg.includes('socket hang up') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('EPIPE') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('network socket disconnected') ||
    msg.includes('Connection lost before handshake')
  );
}

/** TeamSpeak query flood / anti-spam (commonly 3329/3331 + "client is flooding"). */
export function isFloodError(error: any): boolean {
  const code = error instanceof TSApiError
    ? error.code
    : error?.response?.data?.status?.code;
  if (code === 524 || code === 3329 || code === 3331) return true;
  const msg = String(
    error instanceof TSApiError
      ? error.message
      : error?.response?.data?.status?.message || error?.message || '',
  ).toLowerCase();
  return msg.includes('flood');
}

function toTsApiError(error: any): never {
  if (error instanceof TeamSpeakUnavailableError) throw error;
  if (error instanceof TeamSpeakFloodError) throw error;
  if (error instanceof TSApiError) {
    if (isTransientNetworkError(error)) throw new TeamSpeakUnavailableError(5);
    throw error;
  }
  if (error.response?.data?.status) {
    throw new TSApiError(
      error.response.data.status.code,
      error.response.data.status.message,
    );
  }
  if (isTransientNetworkError(error)) {
    throw new TeamSpeakUnavailableError(5);
  }
  throw new TSApiError(-1, error.message || 'Connection failed');
}

interface QueueEntry<T> {
  priority: WebQueryPriority;
  enqueuedAt: number;
  op: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function createWebQueryClient(
  host: string,
  port: number,
  apiKey: string,
  useHttps: boolean = false,
): WebQueryClient {
  if (!isAllowedTsServerHost(host)) {
    throw new AppError(400, 'Invalid TeamSpeak server host');
  }
  const endpoint = createValidatedTsServerEndpoint(host, port, useHttps, port || 10080);
  return new WebQueryClient(endpoint, apiKey);
}

export class WebQueryClient {
  private http: AxiosInstance;
  private agent: http.Agent | https.Agent;
  private queue: QueueEntry<any>[] = [];
  private pumping = false;
  private nextAllowedAt = 0;
  private floodPauseUntil = 0;
  private floodStrikes = 0;

  constructor(
    endpoint: ValidatedTsServerEndpoint,
    apiKey: string,
  ) {
    const baseURL = endpoint.origin;
    const useHttpsResolved = endpoint.useHttps;

    // Use a single persistent TCP connection (keep-alive) to the TS WebQuery API.
    // Without this, each concurrent request opens a new TCP connection, and the
    // TS server registers each one as a separate "serveradmin" query client
    // (serveradmin, serveradmin1, serveradmin2, ...).
    this.agent = useHttpsResolved
      ? new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: !config.tsAllowSelfSigned })
      : new http.Agent({ keepAlive: true, maxSockets: 1 });

    this.http = axios.create({
      baseURL,
      headers: { 'x-api-key': apiKey },
      timeout: 15000,
      // Stay on the validated TeamSpeak origin — never follow redirects off-host.
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
      maxBodyLength: 2 * 1024 * 1024,
      httpAgent: useHttpsResolved ? undefined : this.agent,
      httpsAgent: useHttpsResolved ? this.agent : undefined,
    });
  }

  /**
   * Enqueue a WebQuery op with priority + global pacing.
   * Serialization alone is not enough — TS still returns "client is flooding"
   * when channeledit/dashboard/cron fire back-to-back.
   */
  private enqueue<T>(op: () => Promise<T>, priority: WebQueryPriority = 'normal'): Promise<T> {
    const retryAfterSeconds = this.getFloodCooldownRemainingSeconds();
    if (retryAfterSeconds > 0) {
      return Promise.reject(new TeamSpeakFloodError(retryAfterSeconds));
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        enqueuedAt: Date.now(),
        op,
        resolve,
        reject,
      });
      void this.pump();
    });
  }

  getFloodCooldownRemainingMs(): number {
    return Math.max(0, this.floodPauseUntil - Date.now());
  }

  private getFloodCooldownRemainingSeconds(): number {
    const remaining = this.getFloodCooldownRemainingMs();
    return remaining > 0 ? Math.max(1, Math.ceil(remaining / 1000)) : 0;
  }

  private enterFloodCooldown(): TeamSpeakFloodError {
    this.floodStrikes += 1;
    const pause = Math.min(
      FLOOD_MAX_PAUSE_MS,
      FLOOD_BASE_PAUSE_MS * 2 ** Math.min(this.floodStrikes - 1, 3),
    );
    this.floodPauseUntil = Date.now() + pause;
    const error = new TeamSpeakFloodError(Math.ceil(pause / 1000));

    console.warn(
      `[WebQuery] TeamSpeak flood protection — pausing query traffic for ${pause}ms (strike ${this.floodStrikes})`,
    );

    // Do not hold a backlog of dashboard/bot/animation requests until the cooldown
    // expires. Fail them now with Retry-After so callers can render a useful state
    // and background jobs can back off instead of stampeding the server later.
    const queued = this.queue.splice(0);
    for (const item of queued) item.reject(error);

    return error;
  }

  private pickNextIndex(): number {
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const cand = this.queue[i];
      const cur = this.queue[best];
      const candRank = PRIORITY_RANK[cand.priority];
      const curRank = PRIORITY_RANK[cur.priority];
      if (candRank < curRank || (candRank === curRank && cand.enqueuedAt < cur.enqueuedAt)) {
        best = i;
      }
    }
    return best;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const waitMs = Math.max(
          0,
          this.nextAllowedAt - Date.now(),
          this.floodPauseUntil - Date.now(),
        );
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }

        const idx = this.pickNextIndex();
        const item = this.queue.splice(idx, 1)[0];
        try {
          const result = await this.withTransientRetry(item.op);
          this.floodStrikes = 0;
          this.floodPauseUntil = 0;
          item.resolve(result);
        } catch (err) {
          if (isFloodError(err)) {
            item.reject(this.enterFloodCooldown());
          } else {
            item.reject(err);
          }
        } finally {
          this.nextAllowedAt = Date.now() + MIN_COMMAND_GAP_MS;
        }
      }
    } finally {
      this.pumping = false;
      if (this.queue.length > 0) {
        void this.pump();
      }
    }
  }

  /**
   * Retry once on stale keep-alive / reset sockets.
   * Never retry flood errors (that makes anti-spam worse).
   */
  private async withTransientRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error: any) {
      if (error instanceof TSApiError || error.response?.data?.status) {
        toTsApiError(error);
      }
      if (!isTransientNetworkError(error)) {
        toTsApiError(error);
      }

      await new Promise((r) => setTimeout(r, 150));
      try {
        return await op();
      } catch (retryError: any) {
        toTsApiError(retryError);
      }
    }
  }

  async execute(
    sid: number,
    command: string,
    params?: Record<string, any>,
    options?: { priority?: WebQueryPriority },
  ): Promise<any> {
    return this.enqueue(async () => {
      // Path is built only from sanitized sid + command; baseURL is a validated origin.
      const path = buildWebQueryPath(sid, command);

      const response = await this.http.get(path, {
        params: this.cleanParams(params),
      });

      const data = response.data;

      if (data.status && data.status.code !== 0) {
        throw new TSApiError(data.status.code, data.status.message);
      }

      return data.body || data;
    }, options?.priority ?? 'normal');
  }

  async executePost(
    sid: number,
    command: string,
    params?: Record<string, any>,
    options?: { priority?: WebQueryPriority },
  ): Promise<any> {
    return this.enqueue(async () => {
      const path = buildWebQueryPath(sid, command);
      const response = await this.http.post(path, null, {
        params: this.cleanParams(params),
      });

      const data = response.data;
      if (data.status && data.status.code !== 0) {
        throw new TSApiError(data.status.code, data.status.message);
      }

      return data.body || data;
    }, options?.priority ?? 'normal');
  }

  private cleanParams(params?: Record<string, any>): Record<string, any> | undefined {
    if (!params) return undefined;
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        cleaned[key] = value;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  async testConnection(): Promise<{ ok: true; version: unknown } | { ok: false; error: string }> {
    try {
      const version = await this.execute(0, 'version', undefined, { priority: 'high' });
      return { ok: true, version };
    } catch (err: any) {
      // Preserve flood / warming-up as HTTP 429/503 via the route error handler instead of
      // collapsing them into a generic "connection failed" toast.
      if (err instanceof TeamSpeakFloodError) throw err;
      if (err instanceof TeamSpeakUnavailableError) throw err;
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Staged read-only WebQuery diagnostics (reachability → auth → permissions → virtual server).
   * Prefer this over testConnection() for operator-facing connection tests.
   */
  async diagnoseConnection(options?: DiagnoseConnectionOptions): Promise<ConnectionDiagnosticReport> {
    return runDiagnoseConnection(this, options);
  }

  destroy(): void {
    this.agent.destroy();
  }
}
