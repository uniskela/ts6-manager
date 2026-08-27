import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { TSApiError } from '../middleware/error-handler.js';
import { config } from '../config.js';

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

export class WebQueryClient {
  private http: AxiosInstance;
  private agent: http.Agent | https.Agent;
  /**
   * Serialize all WebQuery HTTP ops on this client.
   * keepAlive + maxSockets:1 already limits TCP, but Promise.all / animation ticks
   * still race at the axios layer and reset the shared socket (ECONNRESET / hang up).
   * Mirror SshQueryClient: one in-flight request at a time.
   */
  private requestChain: Promise<void> = Promise.resolve();

  constructor(
    host: string,
    port: number,
    apiKey: string,
    useHttps: boolean = false,
  ) {
    const protocol = useHttps ? 'https' : 'http';

    // Use a single persistent TCP connection (keep-alive) to the TS WebQuery API.
    // Without this, each concurrent request opens a new TCP connection, and the
    // TS server registers each one as a separate "serveradmin" query client
    // (serveradmin, serveradmin1, serveradmin2, ...).
    this.agent = useHttps
      ? new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: !config.tsAllowSelfSigned })
      : new http.Agent({ keepAlive: true, maxSockets: 1 });

    this.http = axios.create({
      baseURL: `${protocol}://${host}:${port}`,
      headers: { 'x-api-key': apiKey },
      timeout: 15000,
      httpAgent: useHttps ? undefined : this.agent,
      httpsAgent: useHttps ? this.agent : undefined,
    });
  }

  /** Run `op` after prior enqueued ops finish (failures do not break the chain). */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.requestChain.then(op, op);
    this.requestChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Retry once on stale keep-alive / reset sockets.
   * Do not destroy the shared agent here — other queued callers may still need it.
   * Node removes the dead socket after ECONNRESET; the retry opens a fresh one.
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

      await new Promise((r) => setTimeout(r, 100));
      try {
        return await op();
      } catch (retryError: any) {
        toTsApiError(retryError);
      }
    }
  }

  async execute(sid: number, command: string, params?: Record<string, any>): Promise<any> {
    return this.enqueue(() =>
      this.withTransientRetry(async () => {
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
      }),
    );
  }

  async executePost(sid: number, command: string, params?: Record<string, any>): Promise<any> {
    return this.enqueue(() =>
      this.withTransientRetry(async () => {
        const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;
        const response = await this.http.post(path, null, {
          params: this.cleanParams(params),
        });

        const data = response.data;
        if (data.status && data.status.code !== 0) {
          throw new TSApiError(data.status.code, data.status.message);
        }

        return data.body || data;
      }),
    );
  }

  // Remove undefined/null values from params
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

  // Test connection — returns version info or a detailed error
  async testConnection(): Promise<{ ok: true; version: unknown } | { ok: false; error: string }> {
    try {
      const version = await this.execute(0, 'version');
      return { ok: true, version };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // Destroy the HTTP agent, closing all keep-alive sockets.
  // Call this for temporary clients (e.g. test connection) to avoid lingering query logins.
  destroy(): void {
    this.agent.destroy();
  }
}
