// === IPTV Types ===

export interface IptvPlaylistSummary {
  id: number;
  name: string;
  url: string;
  serverConfigId: number;
  autoRefreshMinutes: number;
  lastRefreshedAt: string | null;
  lastError: string | null;
  channelCount: number;
  createdAt: string;
}

export interface IptvChannelInfo {
  id: number;
  playlistId: number;
  name: string;
  url: string;
  logo: string | null;
  groupTitle: string | null;
  tvgId: string | null;
  position: number;
}

export interface IptvChannelPage {
  total: number;
  page: number;
  pageSize: number;
  channels: IptvChannelInfo[];
}

export interface CreateIptvPlaylistRequest {
  name: string;
  url: string;
  serverConfigId: number;
  autoRefreshMinutes?: number;
}
