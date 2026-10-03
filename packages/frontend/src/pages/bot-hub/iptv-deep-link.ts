export interface IptvDeepLink {
  playlistId: number;
  channelKey: string;
}

/** Parse playlistId:channelKey, preserving additional colons in the key. */
export function parseIptvDeepLink(value: string | null): IptvDeepLink | null {
  if (!value) return null;
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  const playlistPart = value.slice(0, separator);
  const channelKey = value.slice(separator + 1);
  if (!/^[1-9]\d*$/.test(playlistPart) || !channelKey) return null;
  const playlistId = Number(playlistPart);
  if (!Number.isSafeInteger(playlistId) || playlistId <= 0) return null;
  return { playlistId, channelKey };
}

/** Stable channel key the console matches on: `tvg-id` when present, else the name. */
export function iptvChannelKey(channel: { tvgId: string | null; name: string }): string {
  return channel.tvgId || channel.name;
}

/** Parse the optional `iptvChannel` row id; tvg-id and name can repeat, the id cannot. */
export function parseIptvChannelId(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** Console URL that pre-selects an IPTV channel. It never starts the stream. */
export function iptvConsolePath(botId: number, playlistId: number, channel: { id: number; tvgId: string | null; name: string }): string {
  const params = new URLSearchParams({ iptv: `${playlistId}:${iptvChannelKey(channel)}`, iptvChannel: String(channel.id) });
  return `/bot-hub/${botId}?${params}`;
}
