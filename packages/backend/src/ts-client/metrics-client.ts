/**
 * Outbound TeamSpeak native metrics scrape client (#91 Slice 1).
 *
 * Separate HTTP listener (default :9187 /metrics). Never inherits WebQuery HTTPS
 * or API-key headers. Built only from persisted admin config (SSRF-safe).
 */

import axios, { type AxiosInstance } from 'axios';
import http from 'http';
import {
  AppError,
} from '../middleware/error-handler.js';
import {
  createValidatedTsServerEndpoint,
  isAllowedTsServerHost,
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

export function createMetricsClient(host: string, port: number = DEFAULT_METRICS_PORT): MetricsClient {
  if (!isAllowedTsServerHost(host)) {
    throw new AppError(400, 'Invalid TeamSpeak metrics host');
  }
  // Metrics listener is HTTP unless a real fixture/docs prove otherwise.
  const endpoint = createValidatedTsServerEndpoint(host, port, false, DEFAULT_METRICS_PORT);
  return new MetricsClient(endpoint);
}

export class MetricsClient {
  private http: AxiosInstance;
  private agent: http.Agent;

  constructor(endpoint: ValidatedTsServerEndpoint) {
    this.agent = new http.Agent({ keepAlive: false, maxSockets: 2 });
    this.http = axios.create({
      baseURL: endpoint.origin,
      timeout: METRICS_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: METRICS_MAX_BYTES,
      maxBodyLength: METRICS_MAX_BYTES,
      responseType: 'text',
      transitional: { forcedJSONParsing: false },
      // No API key / Authorization — metrics are unauthenticated by design.
      headers: { Accept: 'text/plain' },
      httpAgent: this.agent,
      validateStatus: () => true,
    });
  }

  async scrape(): Promise<MetricsScrapeResult> {
    const fetchedAt = new Date().toISOString();
    try {
      const response = await this.http.get(METRICS_PATH);
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
      return { ok: false, reason: 'unreachable', fetchedAt };
    }
  }

  destroy(): void {
    this.agent.destroy();
  }
}
