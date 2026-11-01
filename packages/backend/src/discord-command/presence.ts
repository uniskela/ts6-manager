import type { PresenceSnapshot } from './adapter.js';

type QueryRow = Record<string, unknown>;

function nickname(row: QueryRow): string | null {
  const name = row.client_nickname;
  return typeof name === 'string' && name.trim() ? name : null;
}

function isHuman(row: QueryRow): boolean {
  return String(row.client_type) === '0';
}

function channelName(row: QueryRow): string | null {
  const name = row.channel_name;
  return typeof name === 'string' && name.trim() ? name : null;
}

/** Map WebQuery serverinfo/channellist/clientlist rows — same human filter as the widget. */
export function presenceFromQueryRows(rows: {
  serverinfo?: QueryRow;
  channels?: QueryRow[];
  clients?: QueryRow[];
}): PresenceSnapshot {
  const info = rows.serverinfo;
  const serverName = typeof info?.virtualserver_name === 'string' ? info.virtualserver_name : null;
  return {
    connected: Boolean(serverName),
    serverName,
    nicknames: (rows.clients ?? []).filter(isHuman).map(nickname).filter((name): name is string => Boolean(name)),
    channels: (rows.channels ?? []).map(channelName).filter((name): name is string => Boolean(name)).map((name) => ({ name })),
  };
}
