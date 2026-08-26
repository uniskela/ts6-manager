/**
 * HTTP client for the Go WebRTC sidecar process.
 * Manages peers, media sources, and health checks.
 */

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

  async createPeer(id: string): Promise<{ sdp: string }> {
    return this.call('POST', '/peer/create', { id });
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

  async setSource(source: string, width?: number, height?: number, framerate?: number, bitrate?: string): Promise<void> {
    await this.call('POST', '/source', {
      source,
      width,
      height,
      framerate,
      bitrate,
    });
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

  private async call(method: string, endpoint: string, body?: any): Promise<any> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.secret) headers['Authorization'] = `Bearer ${this.secret}`;

    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
