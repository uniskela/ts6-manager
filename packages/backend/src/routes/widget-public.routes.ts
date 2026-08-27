import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { buildWidgetTree } from '../widget/build-widget-tree.js';
import { renderWidgetSvg } from '../widget/widget-svg.js';
import type { WidgetData } from '@ts6/common';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';
import { config } from '../config.js';

// Simple in-process cache (45s TTL) with bounded size
interface CacheEntry { data: WidgetData; expiresAt: number; }
export const widgetDataCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 45_000;
const MAX_CACHE_SIZE = 1000;

// M7: Periodic cleanup of expired cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of widgetDataCache) {
    if (entry.expiresAt < now) widgetDataCache.delete(key);
  }
}, 60_000);

async function getWidgetData(token: string, req: Request): Promise<WidgetData | null> {
  const cached = widgetDataCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const prisma = req.app.locals.prisma;
  const widget = await prisma.widget.findUnique({
    where: { token },
    include: { serverConfig: { select: { host: true } } },
  });
  if (!widget) return null;

  const pool: ConnectionPool = req.app.locals.connectionPool;
  let client;
  try {
    client = pool.getClient(widget.serverConfigId);
  } catch {
    return null; // server offline
  }

  const sid = widget.virtualServerId;

  const [serverInfoRaw, channelListRaw, clientListRaw] = await Promise.all([
    client.execute(sid, 'serverinfo', undefined, { priority: 'low' }),
    client.execute(sid, 'channellist', undefined, { priority: 'low' }),
    client.execute(sid, 'clientlist', undefined, { priority: 'low' }),
  ]);

  const info = Array.isArray(serverInfoRaw) ? serverInfoRaw[0] : serverInfoRaw;
  const channels = Array.isArray(channelListRaw) ? channelListRaw : [];
  const clients = Array.isArray(clientListRaw) ? clientListRaw : [];
  const onlineClients = clients.filter((c: any) => String(c.client_type) === '0');

  const data: WidgetData = {
    serverName: info.virtualserver_name || 'TeamSpeak Server',
    serverHost: widget.serverConfig.host,
    serverPort: Number(info.virtualserver_port) || 9987,
    onlineUsers: onlineClients.length,
    maxClients: Number(info.virtualserver_maxclients) || 0,
    uptime: Number(info.virtualserver_uptime) || 0,
    // M8: Redact server version/platform to prevent targeted vulnerability scanning
    platform: 'TeamSpeak',
    version: '',
    theme: widget.theme as any,
    showChannelTree: widget.showChannelTree,
    showClients: widget.showClients,
    channelTree: widget.showChannelTree
      ? buildWidgetTree(channels, clients, widget.maxChannelDepth, widget.showClients, widget.hideEmptyChannels ?? false)
      : [],
    fetchedAt: new Date().toISOString(),
  };

  // M7: Evict oldest entry if cache is full
  if (widgetDataCache.size >= MAX_CACHE_SIZE) {
    const firstKey = widgetDataCache.keys().next().value;
    if (firstKey) widgetDataCache.delete(firstKey);
  }
  widgetDataCache.set(token, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

export const widgetPublicRoutes: Router = Router();

// GET /:token/data — JSON widget data
widgetPublicRoutes.get('/:token/data', async (req: Request, res: Response, next) => {
  try {
    const token = req.params.token as string;
    const data = await getWidgetData(token, req);
    if (!data) return res.status(404).json({ error: 'Widget not found or server offline' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=45');
    res.json(data);
  } catch (err) { next(err); }
});

// GET /:token/image.svg — SVG image
widgetPublicRoutes.get('/:token/image.svg', async (req: Request, res: Response, next) => {
  try {
    const token = req.params.token as string;
    const data = await getWidgetData(token, req);
    if (!data) return res.status(404).send('Widget not found');
    const svg = renderWidgetSvg(data);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=45');
    res.send(svg);
  } catch (err) { next(err); }
});

// GET /:token/image.png — PNG image
widgetPublicRoutes.get('/:token/image.png', async (req: Request, res: Response, next) => {
  try {
    const token = req.params.token as string;
    const data = await getWidgetData(token, req);
    if (!data) return res.status(404).send('Widget not found');
    const svg = renderWidgetSvg(data);

    let pngBuffer: Buffer;
    try {
      const { Resvg } = await import('@resvg/resvg-js');
      const resvg = new Resvg(svg, { fitTo: { mode: 'width' as const, value: 400 } });
      pngBuffer = Buffer.from(resvg.render().asPng());
    } catch {
      // If @resvg/resvg-js is not available, fall back to SVG
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(svg);
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=45');
    res.send(pngBuffer);
  } catch (err) { next(err); }
});

// --- Player Widget (Music Bot) ---

/** Generate a deterministic token for a bot ID using HMAC */
function playerWidgetToken(botId: number): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(`player-widget:${botId}`).digest('hex').slice(0, 16);
}

/** Exported so admin routes can generate tokens for the UI */
export { playerWidgetToken };

// GET /player/:botId/data?token=xxx — JSON: now playing + upcoming queue
widgetPublicRoutes.get('/player/:botId/data', async (req: Request, res: Response, next) => {
  try {
    const botId = parseInt(String(req.params.botId));
    const token = req.query.token as string;
    if (!token || token !== playerWidgetToken(botId)) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(botId);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const nowPlaying = bot.nowPlaying;
    const progress = bot.playbackProgress;
    const queueItems = bot.queue.getAll();
    const upcoming = queueItems.slice(0, 5);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=10');
    res.json({
      nowPlaying: nowPlaying ? { title: nowPlaying.title, artist: nowPlaying.artist, duration: nowPlaying.duration, source: nowPlaying.source } : null,
      progress: progress ? { position: progress.position, duration: progress.duration } : null,
      status: bot.status,
      queueLength: queueItems.length,
      upcoming: upcoming.map((q) => ({ title: q.title, artist: q.artist, duration: q.duration })),
    });
  } catch (err) { next(err); }
});

// GET /player/:botId/bbcode?token=xxx — BBCode for TS channel description
widgetPublicRoutes.get('/player/:botId/bbcode', async (req: Request, res: Response, next) => {
  try {
    const botId = parseInt(String(req.params.botId));
    const token = req.query.token as string;
    if (!token || token !== playerWidgetToken(botId)) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(botId);
    if (!bot) return res.status(404).send('Bot not found');

    const nowPlaying = bot.nowPlaying;
    const progress = bot.playbackProgress;
    const queueItems = bot.queue.getAll();
    const upcoming = queueItems.slice(0, 5);

    let bb = '[b]🎵 Now Playing[/b]\n';
    if (nowPlaying) {
      const artist = nowPlaying.artist ? ` — ${nowPlaying.artist}` : '';
      bb += `[color=#00aaff]${nowPlaying.title}${artist}[/color]\n`;
      if (progress) {
        const pos = formatTime(progress.position);
        const dur = formatTime(progress.duration);
        bb += `${pos} / ${dur}\n`;
      }
    } else {
      bb += '[i]Nothing playing[/i]\n';
    }

    if (upcoming.length > 0) {
      bb += '\n[b]Up Next[/b]\n';
      upcoming.forEach((item, i) => {
        const artist = item.artist ? ` — ${item.artist}` : '';
        bb += `${i + 1}. ${item.title}${artist}\n`;
      });
      if (queueItems.length > 5) {
        bb += `[i]... and ${queueItems.length - 5} more[/i]\n`;
      }
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=10');
    res.send(bb);
  } catch (err) { next(err); }
});

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
