import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { TSApiError } from '../middleware/error-handler.js';
import { config } from '../config.js';
import type { ValidatedTsServerEndpoint } from '../utils/validate-ts-host.js';
import { AppError } from '../middleware/error-handler.js';
import { createValidatedTsServerEndpoint, isAllowedTsServerHost } from '../utils/validate-ts-host.js';

/** UI / interactive traffic jumps ahead of background bots & animations. */
export type WebQueryPriority = 'high' | 'normal' | 'low';

const PRIORITY_RANK: Record<WebQueryPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

/** Minimum gap between WebQuery commands — TS flood protection trips without this. */
const MIN_COMMAND_GAP_MS = 250;
const FLOOD_BASE_PAUSE_MS = 5_000;
const FLOOD_MAX_PAUSE_MS = 30_000;

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

function isTransientNetworkError(error: any): boolean {
  const code = error?.code || error?.cause?.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = String(error?.message || '');
  return (
    msg.includes('socket hang up') ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('network socket disconnected')
  );
}

/** TeamSpeak query flood / anti-spam (commonly 3329/3331 + "client is flooding"). */
export function isFloodError(error: any): boolean {
  const code = error instanceof TSApiError
    ? error.code
    : error?.response?.data?.status?.code;
  if (code === 3329 || code === 3331) return true;
  const msg = String(
    error instanceof TSApiError
      ? error.message
      : error?.response?.data?.status?.message || error?.message || '',
  ).toLowerCase();
  return msg.includes('flood');
}

function toTsApiError(error: any): never {
  if (error instanceof TSApiError) throw error;
  if (error.response?.data?.status) {
    throw new TSApiError(
      error.response.data.status.code,
      error.response.data.status.message,
    );
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
          item.resolve(result);
        } catch (err) {
          if (isFloodError(err)) {
            this.floodStrikes += 1;
            const pause = Math.min(
              FLOOD_MAX_PAUSE_MS,
              FLOOD_BASE_PAUSE_MS * 2 ** Math.min(this.floodStrikes - 1, 3),
            );
            this.floodPauseUntil = Date.now() + pause;
            console.warn(
              `[WebQuery] TeamSpeak flood protection — pausing query traffic for ${pause}ms (strike ${this.floodStrikes})`,
            );
          }
          item.reject(err);
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
      // WebQuery URL pattern: /{sid}/{command}
      // For instance-level commands (sid=0): /{command}
      const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;

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
      const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;
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
      return { ok: false, error: err?.message || String(err) };
    }
  }

  destroy(): void {
    this.agent.destroy();
  }
}
