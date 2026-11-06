import { createApp } from './app.js';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { PrismaClient } from '../generated/prisma/index.js';
import { ConnectionPool } from './ts-client/connection-pool.js';
import { BotEngine } from './bot-engine/engine.js';
import { VoiceBotManager } from './voice/voice-bot-manager.js';
import { MusicCommandHandler } from './voice/music-command-handler.js';
import { ListenerRemoteService } from './voice/listener-remote.js';
import { config } from './config.js';
import { describeTrustProxy } from './trust-proxy.js';
import { setYtCookieFile } from './voice/audio/youtube.js';
import { logYtDlpVersionInBackground } from './voice/audio/yt-dlp-diagnostics.js';
import jwt from 'jsonwebtoken';
import { setWsSession } from './ws/ws-session.js';
import type { JwtPayload } from '@ts6/common';
import fs from 'fs';
import path from 'path';
import { startIptvAutoRefresh } from './iptv/iptv-scheduler.js';
import { ListenerRemoteRefusalAudit, startAuditRetention } from './audit/index.js';
import { bootstrapLocalDevConnection } from './bootstrap/local-dev-connection.js';
import { ActivityJournalService } from './activity-journal/activity-journal-service.js';
import { startMediaEgress } from './voice/egress/media-egress.js';
import { runInOrderWithin } from './utils/ordered-shutdown.js';
import {
  clearDiscordCommandRuntime,
  createBackendDiscordCommandRuntime,
  installDiscordCommandRuntime,
} from './discord-command/backend-runtime.js';
import { createDiscordWebhookFollowUpFromConfig } from './discord-command/discord-delivery.js';
import { listenHttpServer } from './listen-host.js';
import {
  assertIsolatedIntegrationStartup,
  shouldEnableIsolatedLiveAdministratorGrant,
} from './startup-isolation.js';

async function main() {
  const isolation = assertIsolatedIntegrationStartup();
  const skipBackgroundJobs = isolation.skipBackgroundJobs;

  // C1: JWT secret startup guard
  if (config.jwtSecret === 'dev-secret-change-me-in-production') {
    if (config.nodeEnv === 'production') {
      console.error('[FATAL] JWT_SECRET is set to the default value. Set a secure JWT_SECRET environment variable before running in production.');
      process.exit(1);
    }
    console.warn('[WARN] JWT_SECRET is using the default development value. Set JWT_SECRET in production!');
  }

  if (config.discordBridgeUrl && !config.discordBridgeSecret && config.nodeEnv === 'production') {
    console.error('[FATAL] DISCORD_BRIDGE_URL is set without DISCORD_BRIDGE_SECRET.');
    process.exit(1);
  }

  // Require a distinct ENCRYPTION_KEY in production (do not fall back to JWT_SECRET)
  if (config.nodeEnv === 'production' && !process.env.ENCRYPTION_KEY) {
    console.error('[FATAL] ENCRYPTION_KEY is required in production. Set a separate AES key (do not reuse JWT_SECRET).');
    process.exit(1);
  }

  // Video sidecar shared secret: required when SIDECAR_URL is set in production
  if (config.nodeEnv === 'production' && process.env.SIDECAR_URL && !process.env.SIDECAR_SECRET) {
    console.error('[FATAL] SIDECAR_SECRET is required when SIDECAR_URL is set in production.');
    process.exit(1);
  }

  // Configure yt-dlp cookie file: env var takes priority, then saved file from data dir
  const cookiePath = process.env.YT_COOKIE_FILE;
  const savedCookiePath = path.resolve('data', 'yt-cookies.txt');
  if (cookiePath && fs.existsSync(cookiePath)) {
    setYtCookieFile(cookiePath);
    console.log(`[yt-dlp] Using cookie file (env): ${cookiePath}`);
  } else if (fs.existsSync(savedCookiePath)) {
    setYtCookieFile(savedCookiePath);
    console.log(`[yt-dlp] Using saved cookie file: ${savedCookiePath}`);
  } else if (cookiePath) {
    console.warn(`[yt-dlp] Cookie file not found: ${cookiePath}`);
  }

  // Non-blocking diagnostic only. Production images never self-update bundled tools.
  if (!skipBackgroundJobs) {
    logYtDlpVersionInBackground();
  }

  const prisma = new PrismaClient();
  const app = createApp();
  const server = createServer(app);

  // H3: WebSocket with JWT authentication + per-user session scoping
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }, done) => {
      try {
        const wsUrl = new URL(req.url!, `http://${req.headers.host}`);
        const token = wsUrl.searchParams.get('token');
        if (!token) return done(false, 401, 'Missing token');
        jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        done(true);
      } catch {
        done(false, 401, 'Invalid token');
      }
    },
  });

  wss.on('connection', async (ws, req) => {
    try {
      const wsUrl = new URL(req.url!, `http://${req.headers.host}`);
      const token = wsUrl.searchParams.get('token');
      if (!token) {
        ws.close(4001, 'Missing token');
        return;
      }
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
      const user = await prisma.user.findUnique({
        where: { id: payload.id },
        select: {
          id: true,
          enabled: true,
          role: true,
          serverAccess: { select: { serverConfigId: true } },
        },
      });
      if (!user || !user.enabled) {
        ws.close(4003, 'User disabled');
        return;
      }
      const allowedServerConfigIds = user.role === 'admin'
        ? new Set<number>()
        : new Set(user.serverAccess.map((a) => a.serverConfigId));
      setWsSession(ws, {
        userId: user.id,
        role: user.role as 'admin' | 'viewer',
        allowedServerConfigIds,
      });
    } catch {
      ws.close(4002, 'Invalid session');
    }
  });

  // Initialize TS connection pool
  const connectionPool = new ConnectionPool(prisma);
  await connectionPool.initialize();

  // Optional local-only seed (pr-test compose). Gated; never crashes boot.
  await bootstrapLocalDevConnection(prisma, connectionPool);

  // Make services available via app.locals
  app.locals.prisma = prisma;
  app.locals.connectionPool = connectionPool;
  app.locals.wss = wss;

  // Initialize Bot Engine
  const botEngine = new BotEngine(prisma, connectionPool, wss, app);
  app.locals.botEngine = botEngine;
  await botEngine.start();

  // Initialize Voice Bot Manager (Music Bots)
  const voiceBotManager = new VoiceBotManager(prisma, wss);
  app.locals.voiceBotManager = voiceBotManager;
  await voiceBotManager.start();

  // Wire VoiceBotManager into BotEngine for voice action nodes in flows
  botEngine.setVoiceBotManager(voiceBotManager);

  // Wire Music Command Handler for text-based music bot control (!radio, !play, etc.)
  // Listens directly on each VoiceBot's TS3 connection (no SSH needed)
  const musicCommandHandler = new MusicCommandHandler(prisma, voiceBotManager);
  const listenerRemote = new ListenerRemoteService();
  app.locals.listenerRemote = listenerRemote;
  // Bounded audit totals for refused listener remote requests.
  const listenerRemoteRefusals = new ListenerRemoteRefusalAudit(prisma);
  app.locals.listenerRemoteRefusals = listenerRemoteRefusals;
  const stopListenerRemoteRefusals = listenerRemoteRefusals.start();
  app.locals.eventBridge = botEngine.getEventBridge();
  musicCommandHandler.setListenerRemote(listenerRemote);
  musicCommandHandler.setEventBridge(botEngine.getEventBridge());
  botEngine.setMusicCommandHandler(musicCommandHandler);
  voiceBotManager.setMusicCommandHandler(musicCommandHandler);
  await musicCommandHandler.refreshAllBotChannels();

  // Discord command runtime: Prisma bindings + shared VoiceBotManager + optional webhook follow-up.
  // HTTP route stays gated by DISCORD_INTERACTIONS_ENABLED.
  // Follow-up is created only when DISCORD_APPLICATION_ID is valid — no Discord HTTP at startup.
  // Construction does not register slash commands or start playback.
  const discordFollowUp = createDiscordWebhookFollowUpFromConfig({
    applicationId: config.discordApplicationId,
  });
  const discordRuntime = createBackendDiscordCommandRuntime({
    prisma,
    voiceBotManager,
    instanceId: config.discordInstanceId,
    policy: {
      viewerRoleIds: config.discordViewerRoleIds,
      adminRoleIds: config.discordAdminRoleIds,
      // Dual latch only — production never sets TS6_ISOLATED_* so this stays false.
      isolatedLiveAdministratorGrant: shouldEnableIsolatedLiveAdministratorGrant(),
    },
    virtualServerIdForBot: (botId) => musicCommandHandler.virtualServerIdForBot(botId),
    followUp: discordFollowUp,
    getTsQueryClient: (serverConfigId) => {
      try {
        return connectionPool.hasClient(serverConfigId)
          ? connectionPool.getClient(serverConfigId)
          : null;
      } catch {
        return null;
      }
    },
    discordBridgeUrl: config.discordBridgeUrl,
    discordBridgeSecret: config.discordBridgeSecret,
    discordBridgeStatusFile: config.discordBridgeStatusFile || undefined,
  });
  installDiscordCommandRuntime(app, discordRuntime);

  // TeamSpeak activity journal (#91 Slice 5) — opt-in per connection/SID
  const activityJournal = new ActivityJournalService(prisma, botEngine.getEventBridge());
  app.locals.activityJournal = activityJournal;
  if (!skipBackgroundJobs) {
    await activityJournal.start();
  } else {
    console.log('[TS6 WebUI] Isolated integration: activity journal not started');
  }

  const stopIptvAutoRefresh = skipBackgroundJobs
    ? () => undefined
    : startIptvAutoRefresh(prisma);
  const stopAuditRetention = skipBackgroundJobs
    ? () => undefined
    : startAuditRetention(prisma);
  if (skipBackgroundJobs) {
    console.log('[TS6 WebUI] Isolated integration: IPTV auto-refresh and audit retention skipped');
  }

  // Media downloads connect only through the checking proxy; log its state before serving.
  if (!skipBackgroundJobs) {
    await startMediaEgress();
  } else {
    console.log('[TS6 WebUI] Isolated integration: media egress bootstrap skipped');
  }

  const listenHost = config.listenHost;
  listenHttpServer(server, config.port, listenHost, () => {
    const where = listenHost
      ? `http://${listenHost}:${config.port}`
      : `http://localhost:${config.port} (all interfaces)`;
    console.log(`[TS6 WebUI] Backend running on ${where}`);
    console.log(`[TS6 WebUI] WebSocket available at ws://localhost:${config.port}/ws`);
    console.log(`[TS6 WebUI] Environment: ${config.nodeEnv}`);
    console.log(`[TS6 WebUI] Trusted proxies: ${describeTrustProxy(config.trustProxy)}`);
    if (skipBackgroundJobs) {
      console.log('[TS6 WebUI] Isolated integration mode active (background jobs reduced)');
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[TS6 WebUI] Shutting down...');
    stopIptvAutoRefresh();
    stopAuditRetention();
    if (!skipBackgroundJobs) {
      await activityJournal.stop();
    }

    // Drop Discord adapter refs before stopping bots so in-flight commands fail closed.
    clearDiscordCommandRuntime(app);
    await voiceBotManager.stopAll();
    await botEngine.destroy();
    connectionPool.destroy();
    wss.close();
    // Stop taking requests, then write the last refusal totals before the database closes.
    // Wait briefly for requests in flight; long-lived connections must not hold up shutdown.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref())]);
    // Write the last refusal totals, then close the database, under one deadline: a stuck
    // write must not hold up shutdown, and the database is never closed under a running write.
    const done = await runInOrderWithin([stopListenerRemoteRefusals, () => prisma.$disconnect()], 5_000);
    if (!done) console.warn('[TS6 WebUI] Shutdown: audit totals or the database did not finish within 5 s; exiting anyway');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
