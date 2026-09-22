// === IPTV Types ===

export type IptvSourceType = 'url' | 'upload';

export interface IptvPlaylistSummary {
  id: number;
  name: string;
  sourceType: IptvSourceType;
  /** Remote URL when sourceType=url; null for uploads */
  url: string | null;
  /** Original filename when sourceType=upload */
  originalFilename: string | null;
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

export interface CreateIptvPlaylistUploadRequest {
  name: string;
  serverConfigId: number;
}
