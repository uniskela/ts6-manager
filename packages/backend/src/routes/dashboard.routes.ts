import { Router, Request, Response } from 'express';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { validateTsQueryServerId } from '../utils/validate-ts-host.js';
import { parsePrometheusText } from '../ts-client/metrics-parse.js';
import {
  applyMetricsAugmentation,
  mapScopedMetrics,
  metricsAugmentationUsed,
  type MetricsAugmentation,
  type MetricsProvenance,
} from '../ts-client/metrics-map.js';
import { takeTrackedIfReadyOrCancel, trackPromise } from '../ts-client/metrics-race.js';

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
  /** Authenticated VS unique id for metrics SID→UID join. */
  virtualserverUniqueIdentifier: string | null;
};

type MetricsFetchBundle = {
  provenance: MetricsProvenance;
  augmentation?: MetricsAugmentation;
};

type MetricsScrapePhase =
  | { kind: 'disabled' }
  | { kind: 'cancelled' }
  | {
      kind: 'scrape';
      result: {
        ok: true;
        body: string;
        contentType: string;
        fetchedAt: string;
      } | {
        ok: false;
        reason: 'timeout' | 'unreachable' | 'invalid';
        fetchedAt: string;
      };
    }
  | { kind: 'unreachable'; fetchedAt: string };

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
  const uidRaw = info?.virtualserver_unique_identifier;
  const virtualserverUniqueIdentifier =
    typeof uidRaw === 'string' && uidRaw.trim().length > 0 ? uidRaw.trim() : null;

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
      virtualserverUniqueIdentifier,
    },
  };
}

function mapScrapeToBundle(
  scrape: Extract<MetricsScrapePhase, { kind: 'scrape' }>['result'],
  sid: number,
  webqueryUniqueId: string | null,
): MetricsFetchBundle {
  if (!scrape.ok) {
    return {
      provenance: {
        status: 'unavailable',
        reason: scrape.reason,
        fetchedAt: scrape.fetchedAt,
      },
    };
  }

  if (!webqueryUniqueId) {
    return {
      provenance: {
        status: 'unavailable',
        reason: 'unscoped',
        fetchedAt: scrape.fetchedAt,
      },
    };
  }

  try {
    const { samples } = parsePrometheusText(scrape.body);
    const mapped = mapScopedMetrics(samples, sid, {
      webqueryUniqueId,
      fetchedAt: scrape.fetchedAt,
    });
    if (!mapped.ok) {
      return {
        provenance: {
          status: 'unavailable',
          reason: mapped.reason,
          fetchedAt: mapped.fetchedAt,
        },
      };
    }

    // Provenance `current` only when at least one metric field was actually used.
    if (!metricsAugmentationUsed(mapped.augmentation) || mapped.usedFields.length === 0) {
      return {
        provenance: {
          status: 'unavailable',
          reason: 'invalid',
          fetchedAt: mapped.fetchedAt,
        },
      };
    }

    return {
      provenance: { status: 'current', fetchedAt: mapped.fetchedAt },
      augmentation: mapped.augmentation,
    };
  } catch {
    return {
      provenance: {
        status: 'unavailable',
        reason: 'invalid',
        fetchedAt: scrape.fetchedAt,
      },
    };
  }
}

dashboardRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const sid = validateTsQueryServerId(req.params.sid);
    const pool: ConnectionPool = req.app.locals.connectionPool;
    const configId = parseInt(String(req.params.configId), 10);

    // Start WebQuery and metrics concurrently. When WebQuery completes, use
    // metrics only if already ready; otherwise cancel the outstanding scrape
    // (do not Promise.all-wait on metrics).
    const metricsAbort = new AbortController();
    const webqueryTask = fetchWebQueryDashboard(req, sid);

    const metricsScrapeTask = trackPromise((async (): Promise<MetricsScrapePhase> => {
      const prisma = req.app.locals.prisma;
      const server = await prisma.tsServerConfig.findUnique({ where: { id: configId } });
      if (!server || server.isDemo || !server.metricsEnabled) {
        return { kind: 'disabled' };
      }
      const metricsClient = pool.getMetricsClient(configId);
      if (!metricsClient) {
        return { kind: 'unreachable', fetchedAt: new Date().toISOString() };
      }
      const result = await metricsClient.scrape(metricsAbort.signal);
      return { kind: 'scrape', result };
    })().catch((): MetricsScrapePhase => ({
      kind: 'unreachable',
      fetchedAt: new Date().toISOString(),
    })));

    const webquery = await webqueryTask;

    const scrapePhase = takeTrackedIfReadyOrCancel(
      metricsScrapeTask,
      () => {
        metricsAbort.abort();
        pool.getMetricsClient(configId)?.cancelPending();
      },
      { kind: 'cancelled' } satisfies MetricsScrapePhase,
    );

    let metrics: MetricsFetchBundle;
    switch (scrapePhase.kind) {
      case 'disabled':
        metrics = { provenance: { status: 'disabled' } };
        break;
      case 'cancelled':
        metrics = {
          provenance: {
            status: 'unavailable',
            reason: 'timeout',
            fetchedAt: new Date().toISOString(),
          },
        };
        break;
      case 'unreachable':
        metrics = {
          provenance: {
            status: 'unavailable',
            reason: 'unreachable',
            fetchedAt: scrapePhase.fetchedAt,
          },
        };
        break;
      case 'scrape':
        metrics = mapScrapeToBundle(
          scrapePhase.result,
          sid,
          webquery.data.virtualserverUniqueIdentifier,
        );
        break;
      default:
        metrics = {
          provenance: {
            status: 'unavailable',
            reason: 'unreachable',
            fetchedAt: new Date().toISOString(),
          },
        };
    }

    const { virtualserverUniqueIdentifier: _uid, ...dashboardFields } = webquery.data;
    const data = metrics.augmentation
      ? applyMetricsAugmentation(dashboardFields, metrics.augmentation)
      : dashboardFields;

    res.json({
      ...data,
      dataSource: {
        webquery: { status: 'current' as const, fetchedAt: webquery.fetchedAt },
        metrics: metrics.provenance,
      },
    });
  } catch (err) { next(err); }
});
