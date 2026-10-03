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
