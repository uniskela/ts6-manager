import type { WebSocket } from 'ws';
import type { WebSocketServer } from 'ws';

export interface WsSession {
  userId: number;
  role: 'admin' | 'viewer';
  /** Empty for admin (all servers); populated for viewers. */
  allowedServerConfigIds: Set<number>;
}

const sessions = new WeakMap<WebSocket, WsSession>();

export function setWsSession(ws: WebSocket, session: WsSession): void {
  sessions.set(ws, session);
}

export function getWsSession(ws: WebSocket): WsSession | undefined {
  return sessions.get(ws);
}

export interface BroadcastFilter {
  /** When set, viewers only receive if this id is in their allow-list. */
  serverConfigId?: number;
}

export function broadcastScoped(
  wss: WebSocketServer,
  type: string,
  payload: Record<string, unknown>,
  filter: BroadcastFilter = {},
): void {
  const msg = JSON.stringify({ type, ...payload });
  const targetServerId = filter.serverConfigId;

  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;

    const session = getWsSession(client);
    if (!session) return;

    if (targetServerId !== undefined && session.role !== 'admin') {
      if (!session.allowedServerConfigIds.has(targetServerId)) return;
    }

    client.send(msg);
  });
}
