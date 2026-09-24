/**
 * Outbound TeamSpeak native metrics scrape client (#91 Slice 1).
 *
 * Separate HTTP listener (default :9187 /metrics). Never inherits WebQuery HTTPS
 * or API-key headers. Built only from persisted admin config (SSRF-safe).
 *
 * DNS is validated at scrape/connect time and the validated address is dialed
 * directly (no TOCTOU rebinding via a second unrestricted lookup).
 */

import axios, { type AxiosRequestConfig } from 'axios';
import http from 'http';
import net from 'net';
import {
  AppError,
} from '../middleware/error-handler.js';
import {
  createValidatedTsServerEndpoint,
  isAllowedTsServerHost,
  resolveValidatedConnectAddress,
  type ValidatedTsServerEndpoint,
} from '../utils/validate-ts-host.js';

export const DEFAULT_METRICS_PORT = 9187;
export const METRICS_PATH = '/metrics';
/** Short timeout so metrics never blocks the dashboard for long. */
export const METRICS_TIMEOUT_MS = 3_000;
/** Cap response body (including decompressed) to limit memory abuse. */
export const METRICS_MAX_BYTES = 1 * 1024 * 1024;

export type MetricsScrapeFailureReason = 'timeout' | 'unreachable' | 'invalid';

export type MetricsScrapeResult =
  | { ok: true; body: string; contentType: string; fetchedAt: string }
  | { ok: false; reason: MetricsScrapeFailureReason; fetchedAt: string };

function isAcceptableMetricsContentType(contentType: string | undefined): boolean {
  // Observed beta13: `text/plain; version=0.0.4; charset=utf-8`
  if (!contentType || !contentType.trim()) return false;
  const lower = contentType.toLowerCase().trim();
  return lower.startsWith('text/plain');
}

function buildOriginForAddress(address: string, port: number): string {
  if (net.isIPv6(address)) {
    return `http://[${address}]:${port}`;
  }
  return `http://${address}:${port}`;
}

export function createMetricsClient(host: string, port: number = DEFAULT_METRICS_PORT): MetricsClient {
  if (!isAllowedTsServerHost(host)) {
    throw new AppError(400, 'Invalid TeamSpeak metrics host');
  }
  // Metrics listener is HTTP unless a real fixture/docs prove otherwise.
  const endpoint = createValidatedTsServerEndpoint(host, port, false, DEFAULT_METRICS_PORT);
  return new MetricsClient(endpoint);
}

export class MetricsClient {
  private agent: http.Agent;
  private endpoint: ValidatedTsServerEndpoint;
  private activeControllers = new Set<AbortController>();

  constructor(endpoint: ValidatedTsServerEndpoint) {
    this.endpoint = endpoint;
    this.agent = new http.Agent({ keepAlive: false, maxSockets: 2 });
  }

  /**
   * Scrape /metrics. Optional AbortSignal cancels an in-flight scrape when
   * WebQuery finishes first (non-blocking dashboard contract).
   */
  async scrape(signal?: AbortSignal): Promise<MetricsScrapeResult> {
    const fetchedAt = new Date().toISOString();
    if (signal?.aborted) {
      return { ok: false, reason: 'timeout', fetchedAt };
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // Resolve + validate now; dial the returned address (no second lookup).
      const connect = await resolveValidatedConnectAddress(this.endpoint.host);
      if (controller.signal.aborted) {
        return { ok: false, reason: 'timeout', fetchedAt };
      }

      const origin = buildOriginForAddress(connect.address, this.endpoint.port);
      const headers: Record<string, string> = { Accept: 'text/plain' };
      // Preserve virtual-host semantics when dialing by IP after hostname resolve.
      if (connect.servername !== connect.address) {
        const hostHeader = net.isIPv6(connect.servername)
          ? `[${connect.servername}]`
          : connect.servername;
        headers.Host = `${hostHeader}:${this.endpoint.port}`;
      }

      const config = {
        timeout: METRICS_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: METRICS_MAX_BYTES,
        maxBodyLength: METRICS_MAX_BYTES,
        responseType: 'text' as const,
        transitional: { forcedJSONParsing: false },
        headers,
        httpAgent: this.agent,
        validateStatus: () => true,
        signal: controller.signal,
        // Pin lookup to the already-validated address (defense in depth if URL
        // somehow retained a hostname — we use the IP origin above).
        lookup: (
          _hostname: string,
          _options: unknown,
          cb: (err: Error | null, address: string, family: number) => void,
        ) => {
          cb(null, connect.address, connect.family);
        },
      } as AxiosRequestConfig;

      const response = await axios.get(`${origin}${METRICS_PATH}`, config);
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: 'invalid', fetchedAt };
      }
      const contentType = String(response.headers['content-type'] ?? '');
      if (!isAcceptableMetricsContentType(contentType)) {
        return { ok: false, reason: 'invalid', fetchedAt };
      }
      const body = typeof response.data === 'string'
        ? response.data
        : Buffer.isBuffer(response.data)
          ? response.data.toString('utf8')
          : '';
      if (!body.trim()) {
        return { ok: false, reason: 'invalid', fetchedAt };
      }
      return { ok: true, body, contentType, fetchedAt };
    } catch (error: any) {
      if (
        controller.signal.aborted
        || signal?.aborted
        || error?.name === 'CanceledError'
        || error?.code === 'ERR_CANCELED'
        || error?.message === 'canceled'
      ) {
        return { ok: false, reason: 'timeout', fetchedAt };
      }
      const code = error?.code || error?.cause?.code;
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || error?.message?.includes('timeout')) {
        return { ok: false, reason: 'timeout', fetchedAt };
      }
      // maxRedirects: 0 → axios throws on redirect; treat as invalid
      if (error?.response?.status && error.response.status >= 300 && error.response.status < 400) {
        return { ok: false, reason: 'invalid', fetchedAt };
      }
      if (
        typeof error?.message === 'string'
        && (error.message.includes('maxContentLength') || error.message.includes('max body'))
      ) {
        return { ok: false, reason: 'invalid', fetchedAt };
      }
      // DNS / host validation failures surface as AppError or lookup errors → invalid/unreachable
      if (error instanceof AppError && error.statusCode === 400) {
        return { ok: false, reason: 'invalid', fetchedAt };
      }
      return { ok: false, reason: 'unreachable', fetchedAt };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activeControllers.delete(controller);
    }
  }

  /** Cancel any in-flight scrapes (dashboard non-blocking path). */
  cancelPending(): void {
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
  }

  destroy(): void {
    this.cancelPending();
    this.agent.destroy();
  }
}
