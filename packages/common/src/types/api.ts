// REST API Types between Frontend <-> Backend

// Auth
export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: UserInfo;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface UserInfo {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'moderator' | 'viewer';
}

// Server Connection Config
export interface ServerConfig {
  id: number;
  name: string;
  host: string;
  webqueryPort: number;
  useHttps: boolean;
  sshPort: number;
  hasSshCredentials: boolean;
  enabled: boolean;
  createdAt: string;
  /** Admin-only: opt-in native metrics scrape. */
  metricsEnabled?: boolean;
  metricsPort?: number;
  /** Admin-only: optional metrics bind host override (null/omit = WebQuery host). */
  metricsHost?: string | null;
}

export interface CreateServerConfig {
  name: string;
  host: string;
  webqueryPort: number;
  apiKey: string;
  useHttps: boolean;
  sshPort: number;
  sshUsername?: string;
  sshPassword?: string;
  metricsEnabled?: boolean;
  metricsPort?: number;
  metricsHost?: string | null;
}

export interface UpdateServerConfig {
  name?: string;
  host?: string;
  webqueryPort?: number;
  apiKey?: string;
  useHttps?: boolean;
  sshPort?: number;
  sshUsername?: string;
  sshPassword?: string;
  enabled?: boolean;
  metricsEnabled?: boolean;
  metricsPort?: number;
  metricsHost?: string | null;
}

/** Staged WebQuery connection diagnostics (#91 Slice 2). */
export type DiagnosticStageId =
  | 'reachability'
  | 'authentication'
  | 'permissions'
  | 'virtual_server';

export type DiagnosticStageStatus = 'ok' | 'fail' | 'skipped';
export type DiagnosticOverall = 'ok' | 'partial' | 'fail';

export interface DiagnosticStageResult {
  id: DiagnosticStageId;
  status: DiagnosticStageStatus;
  message: string;
  code?: string;
}

export interface ConnectionDiagnosticReport {
  success: boolean;
  partial: boolean;
  overall: DiagnosticOverall;
  stages: DiagnosticStageResult[];
  version?: string;
}

// Dashboard
export type DashboardWebQuerySourceStatus = 'current' | 'unavailable';
export type DashboardMetricsSourceStatus = 'disabled' | 'current' | 'unavailable';
export type DashboardMetricsUnavailableReason = 'timeout' | 'unreachable' | 'invalid' | 'unscoped';

export interface DashboardDataSource {
  webquery: {
    status: DashboardWebQuerySourceStatus;
    fetchedAt?: string;
  };
  metrics: {
    status: DashboardMetricsSourceStatus;
    fetchedAt?: string;
    reason?: DashboardMetricsUnavailableReason;
  };
}

export interface DashboardData {
  serverName: string;
  platform: string;
  version: string;
  onlineUsers: number;
  maxClients: number;
  uptime: number;
  channelCount: number;
  bandwidth: {
    incoming: number;
    outgoing: number;
  };
  packetloss: number;
  ping: number;
  /** Composite provenance — never label mixed responses as metrics-only. */
  dataSource?: DashboardDataSource;
}

// Channel operations
export interface CreateChannelRequest {
  channel_name: string;
  channel_topic?: string;
  channel_description?: string;
  channel_password?: string;
  cpid?: number;
  channel_order?: number;
  channel_codec?: number;
  channel_codec_quality?: number;
  channel_maxclients?: number;
  channel_maxfamilyclients?: number;
  channel_flag_permanent?: number;
  channel_flag_semi_permanent?: number;
  channel_flag_temporary?: number;
  channel_flag_default?: number;
  channel_needed_talk_power?: number;
}

export interface MoveChannelRequest {
  cpid: number;
  order?: number;
}

// Client actions
export interface KickClientRequest {
  reasonid: 4 | 5; // 4=channel, 5=server
  reasonmsg?: string;
}

export interface BanClientRequest {
  time?: number; // seconds, 0=permanent
  banreason?: string;
}

export interface MoveClientRequest {
  cid: number;
  cpw?: string;
}

export interface PokeClientRequest {
  msg: string;
}

export interface MessageRequest {
  targetmode: 1 | 2 | 3; // 1=client, 2=channel, 3=server
  target?: number;
  msg: string;
}

// Ban
export interface CreateBanRequest {
  ip?: string;
  name?: string;
  uid?: string;
  time?: number;
  banreason?: string;
}

// Token
export interface CreateTokenRequest {
  tokentype: 0 | 1; // 0=server group, 1=channel group tokens)
  tokenid1: number; // group id
  tokenid2: number; // channel id (for channel group tokens)
  tokendescription?: string;
}

// Group operations
export interface CreateGroupRequest {
  name: string;
  type?: number;
}

export interface GroupMemberAction {
  cldbid: number;
}

// Permission operations
export interface SetPermissionRequest {
  permid?: number;
  permsid?: string;
  permvalue: number;
  permnegated?: number;
  permskip?: number;
}

// User management (webapp)
export interface CreateUserRequest {
  username: string;
  password: string;
  displayName: string;
  role: 'admin' | 'moderator' | 'viewer';
}

export interface UpdateUserRequest {
  displayName?: string;
  role?: 'admin' | 'moderator' | 'viewer';
  enabled?: boolean;
  password?: string;
}

// Generic API response wrapper
export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: string;
  code?: number;
  details?: string;
}

// Paginated response
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  offset: number;
  limit: number;
}

/** TeamSpeak logview page envelope (#91 Slice 3 — Logs 2.0). */
export const LOGVIEW_MIN_LINES = 1;
export const LOGVIEW_MAX_LINES = 100;

export interface ServerLogEntry {
  sourceText: string;
  lastPos: string | null;
}

export interface ServerLogPageContext {
  configId: number;
  sid: number;
  /** True when rows come from the instance/master logfile. */
  instance: boolean;
  reverse: boolean;
  lines: number;
  beginPos: string | null;
}

export interface ServerLogPage {
  entries: ServerLogEntry[];
  context: ServerLogPageContext;
  fetchedAt: string;
  fileSize: string | null;
  /** Verified Older-page cursor from TeamSpeak `last_pos`; never invented. */
  nextBeginPos: string | null;
}

// === Server Widget / Banner ===

export type WidgetTheme = 'dark' | 'light' | 'transparent' | 'neon' | 'military' | 'minimal';

export interface WidgetConfig {
  id: number;
  name: string;
  token: string;
  serverConfigId: number;
  virtualServerId: number;
  theme: WidgetTheme;
  showChannelTree: boolean;
  showClients: boolean;
  hideEmptyChannels: boolean;
  maxChannelDepth: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWidgetRequest {
  name: string;
  serverConfigId: number;
  virtualServerId?: number;
  theme?: WidgetTheme;
  showChannelTree?: boolean;
  showClients?: boolean;
  hideEmptyChannels?: boolean;
  maxChannelDepth?: number;
}

export interface UpdateWidgetRequest {
  name?: string;
  theme?: WidgetTheme;
  showChannelTree?: boolean;
  showClients?: boolean;
  hideEmptyChannels?: boolean;
  maxChannelDepth?: number;
}

export interface WidgetData {
  serverName: string;
  serverHost: string;
  serverPort: number;
  onlineUsers: number;
  maxClients: number;
  uptime: number;
  platform: string;
  version: string;
  theme: WidgetTheme;
  showChannelTree: boolean;
  showClients: boolean;
  channelTree: WidgetChannelNode[];
  fetchedAt: string;
}

export interface WidgetChannelNode {
  cid: number;
  name: string;
  hasPassword: boolean;
  isspacer: boolean;
  spacerType: 'line' | 'dotline' | 'dashline' | 'center' | 'left' | 'right' | 'none';
  spacerText: string;
  clients: WidgetClient[];
  children: WidgetChannelNode[];
}

export interface WidgetClient {
  clid: number;
  nickname: string;
  isAway: boolean;
  isMuted: boolean;
}

// === #91 Slice 5 — TeamSpeak activity journal ===

export type ActivityEventKind = 'join' | 'leave';
export type ActivityClassification = 'known_bot' | 'query' | 'voice' | 'unknown';
export type ActivityIdentityProvenance = 'event' | 'cache' | 'mixed' | 'none';
export type ActivityCaptureStatus =
  | 'disabled'
  | 'connecting'
  | 'capturing'
  | 'interrupted'
  | 'persistence_error';

export interface ActivityJournalRetention {
  days: number;
  perConnectionSid: number;
  global: number;
  queueCapacity: number;
}

export interface ActivityJournalTarget {
  serverConfigId: number;
  virtualServerId: number;
  enabled: boolean;
}

export interface ActivityJournalStatus {
  serverConfigId: number;
  virtualServerId: number;
  enabled: boolean;
  status: ActivityCaptureStatus;
  queueDepth: number;
  queueCapacity: number;
  droppedEvents: number;
  lastError: string | null;
  lastPersistedAt: string | null;
  sshConnected: boolean;
  sshRegistered: boolean;
  connectionGeneration: number;
}

export interface ClientActivityEntry {
  id: string;
  observedAt: string;
  serverConfigId: number;
  virtualServerId: number;
  connectionGeneration: number;
  eventKind: ActivityEventKind;
  clientId: number;
  nickname: string | null;
  uniqueId: string | null;
  databaseId: number | null;
  clientType: number | null;
  classification: ActivityClassification;
  identityProvenance: ActivityIdentityProvenance;
}

export interface ActivityJournalHistoryResponse {
  items: ClientActivityEntry[];
  nextCursor: string | null;
}
