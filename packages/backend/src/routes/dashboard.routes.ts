import { Router, Request, Response } from 'express';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { validateTsQueryServerId } from '../utils/validate-ts-host.js';
import { parsePrometheusText } from '../ts-client/metrics-parse.js';
import {
  mapScopedMetrics,
  type MetricsProvenance,
} from '../ts-client/metrics-map.js';
import type { MetricsScrapeFailureReason } from '../ts-client/metrics-client.js';

export const dashboardRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId), 10));
};

type WebQueryDashboard = {
  serverName: string;
  platform: string;
  version: string;
  onlineUsers: number;
  maxClients: number;
  uptime: number;
  channelCount: number;
  bandwidth: { incoming: number; outgoing: number };
  packetloss: number;
  ping: number;
};

async function fetchWebQueryDashboard(req: Request, sid: number): Promise<{ data: WebQueryDashboard; fetchedAt: string }> {
  const client = getClient(req);
  const fetchedAt = new Date().toISOString();

  const [serverInfo, clientList, channelList, connectionInfo] = await Promise.all([
    client.execute(sid, 'serverinfo', undefined, { priority: 'high' }),
    client.execute(sid, 'clientlist', undefined, { priority: 'high' }),
    client.execute(sid, 'channellist', undefined, { priority: 'high' }),
    client.execute(sid, 'serverrequestconnectioninfo', undefined, { priority: 'high' }),
  ]);

  const info = Array.isArray(serverInfo) ? serverInfo[0] : serverInfo;
  const connInfo = Array.isArray(connectionInfo) ? connectionInfo[0] : connectionInfo;
  const clients = Array.isArray(clientList) ? clientList : [];
  const channels = Array.isArray(channelList) ? channelList : [];

  const onlineClients = clients.filter((c: any) => String(c.client_type) === '0');

  return {
    fetchedAt,
    data: {
      serverName: info.virtualserver_name,
      platform: info.virtualserver_platform,
      version: info.virtualserver_version,
      onlineUsers: onlineClients.length,
      maxClients: Number(info.virtualserver_maxclients) || 0,
      uptime: Number(info.virtualserver_uptime) || 0,
      channelCount: channels.length,
      bandwidth: {
        incoming: Number(connInfo.connection_bandwidth_received_last_second_total) || 0,
        outgoing: Number(connInfo.connection_bandwidth_sent_last_second_total) || 0,
      },
      packetloss: Number(info.virtualserver_total_packetloss_total) || 0,
      ping: Number(info.virtualserver_total_ping) || 0,
    },
  };
}

async function fetchMetricsProvenance(req: Request, sid: number): Promise<MetricsProvenance> {
  const configId = parseInt(String(req.params.configId), 10);
  const prisma = req.app.locals.prisma;
  const pool: ConnectionPool = req.app.locals.connectionPool;

  const server = await prisma.tsServerConfig.findUnique({ where: { id: configId } });
  if (!server || server.isDemo || !server.metricsEnabled) {
    return { status: 'disabled' };
  }

  const metricsClient = pool.getMetricsClient(configId);
  if (!metricsClient) {
    return { status: 'unavailable', reason: 'unreachable', fetchedAt: new Date().toISOString() };
  }

  const scrape = await metricsClient.scrape();
  if (!scrape.ok) {
    return {
      status: 'unavailable',
      reason: scrape.reason as MetricsScrapeFailureReason,
      fetchedAt: scrape.fetchedAt,
    };
  }

  try {
    const { samples } = parsePrometheusText(scrape.body);
    const mapped = mapScopedMetrics(samples, sid, scrape.fetchedAt);
    if (!mapped.ok) {
      return { status: 'unavailable', reason: mapped.reason, fetchedAt: mapped.fetchedAt };
    }
    return { status: 'current', fetchedAt: mapped.fetchedAt };
  } catch {
    return { status: 'unavailable', reason: 'invalid', fetchedAt: scrape.fetchedAt };
  }
}

dashboardRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const sid = validateTsQueryServerId(req.params.sid);

    // Start WebQuery and metrics concurrently. Metrics must never fail the WebQuery path.
    const webqueryTask = fetchWebQueryDashboard(req, sid);
    const metricsTask = fetchMetricsProvenance(req, sid).catch((): MetricsProvenance => ({
      status: 'unavailable',
      reason: 'unreachable',
      fetchedAt: new Date().toISOString(),
    }));

    const [webquery, metrics] = await Promise.all([webqueryTask, metricsTask]);

    res.json({
      ...webquery.data,
      dataSource: {
        webquery: { status: 'current' as const, fetchedAt: webquery.fetchedAt },
        metrics,
      },
    });
  } catch (err) { next(err); }
});
