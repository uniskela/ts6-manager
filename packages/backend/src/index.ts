import { createApp } from './app.js';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { PrismaClient } from '../generated/prisma/index.js';
import { ConnectionPool } from './ts-client/connection-pool.js';
import { BotEngine } from './bot-engine/engine.js';
import { VoiceBotManager } from './voice/voice-bot-manager.js';
import { MusicCommandHandler } from './voice/music-command-handler.js';
import { config } from './config.js';
import { setYtCookieFile } from './voice/audio/youtube.js';
import { updateYtDlpInBackground } from './voice/audio/yt-dlp-update.js';
import jwt from 'jsonwebtoken';
import { setWsSession } from './ws/ws-session.js';
import type { JwtPayload } from '@ts6/common';
import fs from 'fs';
import path from 'path';
import { startIptvAutoRefresh } from './iptv/iptv-scheduler.js';

async function main() {
  // C1: JWT secret startup guard
  if (config.jwtSecret === 'dev-secret-change-me-in-production') {
    if (config.nodeEnv === 'production') {
      console.error('[FATAL] JWT_SECRET is set to the default value. Set a secure JWT_SECRET environment variable before running in production.');
      process.exit(1);
    }
    console.warn('[WARN] JWT_SECRET is using the default development value. Set JWT_SECRET in production!');
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

  // Non-blocking yt-dlp self-update (opt out with YT_DLP_AUTO_UPDATE=0)
  updateYtDlpInBackground();

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
  musicCommandHandler.setEventBridge(botEngine.getEventBridge());
  botEngine.setMusicCommandHandler(musicCommandHandler);
  voiceBotManager.setMusicCommandHandler(musicCommandHandler);
  await musicCommandHandler.refreshAllBotChannels();

  const stopIptvAutoRefresh = startIptvAutoRefresh(prisma);

  server.listen(config.port, () => {
    console.log(`[TS6 WebUI] Backend running on http://localhost:${config.port}`);
    console.log(`[TS6 WebUI] WebSocket available at ws://localhost:${config.port}/ws`);
    console.log(`[TS6 WebUI] Environment: ${config.nodeEnv}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[TS6 WebUI] Shutting down...');
    stopIptvAutoRefresh();
    await voiceBotManager.stopAll();
    botEngine.destroy();
    connectionPool.destroy();
    wss.close();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
