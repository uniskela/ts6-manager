import { PrismaClient } from '../../generated/prisma/index.js';
import { WebQueryClient, createWebQueryClient } from './webquery-client.js';
import { decrypt } from '../utils/crypto.js';
import { DemoWebQueryClient } from './demo-webquery-client.js';
import { createMetricsClient, type MetricsClient } from './metrics-client.js';

export class ConnectionPool {
  private clients: Map<number, WebQueryClient> = new Map();
  private metricsClients: Map<number, MetricsClient> = new Map();

  constructor(private prisma: PrismaClient) {}

  async initialize(): Promise<void> {
    const servers = await this.prisma.tsServerConfig.findMany({
      where: { enabled: true },
    });

    for (const server of servers) {
      if (server.isDemo) {
        this.addDemoClient(server.id);
        continue;
      }

      // H8: Decrypt API key before use
      this.addClient(server.id, server.host, server.webqueryPort, decrypt(server.apiKey), server.useHttps);
      this.syncMetricsClient(server);

      // Validate restored credentials once during startup so bad/stale keys are
      // visible immediately instead of first surfacing from background bot traffic.
      // Run the probe in the background: an unreachable TeamSpeak server must not
      // delay WebUI startup for the HTTP client's full timeout.
      const client = this.getClient(server.id);
      void client.testConnection()
        .then((result) => {
          if (!result.ok) {
            console.warn(`[ConnectionPool] WebQuery validation failed for server config ${server.id}: ${result.error}`);
          }
        })
        .catch((err: any) => {
          console.warn(`[ConnectionPool] WebQuery validation failed for server config ${server.id}: ${err?.message || String(err)}`);
        });
    }

    console.log(`[ConnectionPool] Initialized ${this.clients.size} server connection(s)`);
  }

  addClient(id: number, host: string, port: number, apiKey: string, useHttps: boolean): void {
    const client = createWebQueryClient(host, port, apiKey, useHttps);
    this.clients.set(id, client);
  }

  addDemoClient(id: number): void {
    this.removeMetricsClient(id);
    this.clients.set(id, new DemoWebQueryClient());
  }

  /**
   * Create/replace/remove the metrics scrape client from persisted config.
   * Demo connections never get a metrics client (network-free).
   */
  syncMetricsClient(server: {
    id: number;
    host: string;
    isDemo?: boolean;
    metricsEnabled?: boolean | null;
    metricsPort?: number | null;
    metricsHost?: string | null;
  }): void {
    this.removeMetricsClient(server.id);
    if (server.isDemo || !server.metricsEnabled) return;

    const host = (server.metricsHost?.trim() || server.host);
    const port = server.metricsPort ?? 9187;
    try {
      this.metricsClients.set(server.id, createMetricsClient(host, port));
    } catch (err: any) {
      console.warn(
        `[ConnectionPool] Metrics client not created for server config ${server.id}: ${err?.message || String(err)}`,
      );
    }
  }

  removeMetricsClient(id: number): void {
    const client = this.metricsClients.get(id);
    if (client) {
      client.destroy();
      this.metricsClients.delete(id);
    }
  }

  removeClient(id: number): void {
    const client = this.clients.get(id);
    if (client) {
      client.destroy();
      this.clients.delete(id);
    }
    this.removeMetricsClient(id);
  }

  getClient(configId: number): WebQueryClient {
    const client = this.clients.get(configId);
    if (!client) {
      throw new Error(`No connection configured for server config ID ${configId}`);
    }
    return client;
  }

  getMetricsClient(configId: number): MetricsClient | null {
    return this.metricsClients.get(configId) ?? null;
  }

  hasClient(configId: number): boolean {
    return this.clients.has(configId);
  }

  async refreshClient(configId: number): Promise<void> {
    // Always tear down the previous WebQuery client so sockets/credentials cannot linger
    this.removeClient(configId);

    const server = await this.prisma.tsServerConfig.findUnique({
      where: { id: configId },
    });
    if (server && server.enabled) {
      if (server.isDemo) {
        this.addDemoClient(server.id);
      } else {
        this.addClient(server.id, server.host, server.webqueryPort, decrypt(server.apiKey), server.useHttps);
        this.syncMetricsClient(server);
      }
    }
  }

  destroy(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
    for (const client of this.metricsClients.values()) {
      client.destroy();
    }
    this.metricsClients.clear();
  }
}
