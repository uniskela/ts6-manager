/**
 * HTTP client for the Go WebRTC sidecar process.
 * Manages peers, media sources, and health checks.
 */

import type { VideoCodec, VideoEncoderCapabilities, VideoEncoderId } from '@ts6/common';

/** Encoder the sidecar reports running after POST /source. */
export interface SidecarEncoderSession {
  requested: VideoEncoderId;
  active: VideoEncoderId;
  codec: VideoCodec;
  hardware: boolean;
  fallbackReason?: string;
  state: string;
  exitError?: string;
}

export interface SidecarSourceOptions {
  width?: number;
  height?: number;
  framerate?: number;
  bitrate?: string;
  volume?: number;
  loop?: boolean;
  encoder?: VideoEncoderId;
}

export interface SidecarStats {
  videoPort: number;
  audioPort: number;
  peerCount: number;
  peers: Record<string, { active: boolean; state: string }>;
  source: string;
}

export class SidecarClient {
  private baseUrl: string;
  private secret: string | undefined;

  constructor(portOrUrl: number | string = 9800, secret?: string) {
    this.baseUrl = typeof portOrUrl === 'string'
      ? portOrUrl.replace(/\/+$/, '')
      : `http://127.0.0.1:${portOrUrl}`;
    this.secret = secret ?? process.env.SIDECAR_SECRET;
  }

  async waitHealthy(timeoutMs: number = 6000): Promise<void> {
    const maxAttempts = Math.ceil(timeoutMs / 200);
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.call('GET', '/health');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error('Sidecar health check timeout');
  }

  /** `codec` must match the encoder's codec family so the viewer negotiates what ffmpeg sends. */
  async createPeer(id: string, codec?: VideoCodec): Promise<{ sdp: string }> {
    return this.call('POST', '/peer/create', codec ? { id, codec } : { id });
  }

  async setAnswer(id: string, sdp: string): Promise<void> {
    await this.call('POST', '/peer/answer', { id, sdp });
  }

  async addIceCandidate(id: string, candidate: string, sdpMid: string, sdpMLineIndex: number): Promise<void> {
    await this.call('POST', '/peer/ice', { id, candidate, sdpMid, sdpMLineIndex });
  }

  async closePeer(id: string): Promise<void> {
    await this.call('POST', '/peer/close', { id });
  }

  /** Start/restart ffmpeg for `source`. Resolves with the encoder actually running. */
  async setSource(source: string, options: SidecarSourceOptions = {}): Promise<SidecarEncoderSession | null> {
    const res = await this.call('POST', '/source', { source, ...options });
    return res?.encoder ?? null;
  }

  /**
   * Encoder capabilities. The sidecar caches its test encodes; the first call
   * (or `refresh`) runs them, so only call this on demand.
   */
  async getEncoders(refresh = false, timeoutMs = 30_000): Promise<VideoEncoderCapabilities> {
    return this.call('GET', refresh ? '/encoders?refresh=1' : '/encoders', undefined, timeoutMs);
  }

  async stopSource(): Promise<void> {
    await this.call('POST', '/source/stop');
  }

  async getStats(): Promise<SidecarStats> {
    return this.call('GET', '/stats');
  }

  async getHealth(): Promise<{ status: string; videoPort: number; audioPort: number }> {
    return this.call('GET', '/health');
  }

  private async call(method: string, endpoint: string, body?: any, timeoutMs?: number): Promise<any> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.secret) headers['Authorization'] = `Bearer ${this.secret}`;

    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sidecar ${endpoint}: ${res.status} ${text}`);
    }
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}
