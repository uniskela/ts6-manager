import { WebQueryClient } from './webquery-client.js';
import { createValidatedTsServerEndpoint } from '../utils/validate-ts-host.js';
import {
  buildFullSuccessReport,
  type ConnectionDiagnosticReport,
  type DiagnoseConnectionOptions,
} from './connection-diagnostics.js';

const DEMO_VERSION = [{
  version: '6.0.0-demo',
  build: 'demo',
  platform: 'Linux',
}];

const DEMO_SERVER_INFO = [{
  virtualserver_id: '1',
  virtualserver_unique_identifier: 'demo-server-uid',
  virtualserver_name: 'Demo TeamSpeak Server',
  virtualserver_status: 'online',
  virtualserver_platform: 'Linux',
  virtualserver_version: '6.0.0-demo',
  virtualserver_port: '9987',
  virtualserver_maxclients: '64',
  virtualserver_clientsonline: '7',
  virtualserver_queryclientsonline: '1',
  virtualserver_channelsonline: '6',
  virtualserver_uptime: '345678',
  virtualserver_total_ping: '24.6',
  virtualserver_total_packetloss_total: '0.18',
  virtualserver_welcomemessage: 'Welcome to the generic TS6 Manager demo server.',
}];

const DEMO_CONNECTION_INFO = [{
  connection_bandwidth_received_last_second_total: '18240',
  connection_bandwidth_sent_last_second_total: '24680',
  connection_packets_received_total: '184256',
  connection_packets_sent_total: '191044',
  connection_bytes_received_total: '167772160',
  connection_bytes_sent_total: '209715200',
}];

const DEMO_CHANNELS = [
  { cid: '1', pid: '0', channel_order: '0', channel_name: 'Lobby', channel_topic: 'Welcome and introductions', channel_description: 'Default lobby for the demo server.', total_clients: '2', channel_flag_default: '1', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec: '4', channel_codec_quality: '7', channel_icon_id: '0' },
  { cid: '2', pid: '0', channel_order: '1', channel_name: 'General', channel_topic: 'General conversation', channel_description: 'A general-purpose channel.', total_clients: '2', channel_flag_default: '0', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec: '4', channel_codec_quality: '7', channel_icon_id: '0' },
  { cid: '3', pid: '2', channel_order: '0', channel_name: 'Project Room', channel_topic: 'Nested channel example', channel_description: 'Demonstrates nested channel rendering.', total_clients: '1', channel_flag_default: '0', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec: '4', channel_codec_quality: '7', channel_icon_id: '0' },
  { cid: '4', pid: '0', channel_order: '2', channel_name: 'Support', channel_topic: 'Help and support', channel_description: 'Password-protected channel example.', total_clients: '1', channel_flag_default: '0', channel_flag_permanent: '1', channel_flag_password: '1', channel_codec: '4', channel_codec_quality: '7', channel_icon_id: '0' },
  { cid: '5', pid: '0', channel_order: '3', channel_name: 'Music', channel_topic: 'Music bot and listening room', channel_description: 'Example media channel.', total_clients: '1', channel_flag_default: '0', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec: '4', channel_codec_quality: '7', channel_icon_id: '0' },
  { cid: '6', pid: '0', channel_order: '4', channel_name: 'AFK', channel_topic: 'Away from keyboard', channel_description: 'Idle users are moved here.', total_clients: '1', channel_flag_default: '0', channel_flag_permanent: '1', channel_flag_password: '0', channel_codec: '4', channel_codec_quality: '7', channel_icon_id: '0' },
];

const DEMO_CLIENTS = [
  { clid: '1', cid: '1', client_database_id: '10', client_unique_identifier: 'demo-admin-uid', client_nickname: 'Demo Admin', client_type: '0', client_country: 'XX', client_servergroups: '6', client_channel_group_id: '5', client_away: '0', client_away_message: '', client_flag_talking: '1', client_input_muted: '0', client_output_muted: '0', client_input_hardware: '1', client_output_hardware: '1', client_idle_time: '1200', client_created: '1700000000', client_lastconnected: '1700000200', client_version: '6.0.0', client_platform: 'Windows' },
  { clid: '2', cid: '1', client_database_id: '11', client_unique_identifier: 'sample-user-uid', client_nickname: 'Sample User', client_type: '0', client_country: 'XX', client_servergroups: '8', client_channel_group_id: '8', client_away: '0', client_away_message: '', client_flag_talking: '0', client_input_muted: '0', client_output_muted: '0', client_input_hardware: '1', client_output_hardware: '1', client_idle_time: '8400', client_created: '1700001000', client_lastconnected: '1700001200', client_version: '6.0.0', client_platform: 'Linux' },
  { clid: '3', cid: '2', client_database_id: '12', client_unique_identifier: 'guest-user-uid', client_nickname: 'Guest User', client_type: '0', client_country: 'XX', client_servergroups: '8', client_channel_group_id: '8', client_away: '0', client_away_message: '', client_flag_talking: '0', client_input_muted: '0', client_output_muted: '0', client_input_hardware: '1', client_output_hardware: '1', client_idle_time: '22000', client_created: '1700002000', client_lastconnected: '1700002200', client_version: '6.0.0', client_platform: 'macOS' },
  { clid: '4', cid: '2', client_database_id: '13', client_unique_identifier: 'muted-user-uid', client_nickname: 'Muted User', client_type: '0', client_country: 'XX', client_servergroups: '8', client_channel_group_id: '8', client_away: '0', client_away_message: '', client_flag_talking: '0', client_input_muted: '1', client_output_muted: '0', client_input_hardware: '1', client_output_hardware: '1', client_idle_time: '32000', client_created: '1700003000', client_lastconnected: '1700003200', client_version: '6.0.0', client_platform: 'Windows' },
  { clid: '5', cid: '3', client_database_id: '14', client_unique_identifier: 'long-name-user-uid', client_nickname: 'Example User With A Deliberately Long Nickname', client_type: '0', client_country: 'XX', client_servergroups: '8', client_channel_group_id: '8', client_away: '0', client_away_message: '', client_flag_talking: '0', client_input_muted: '0', client_output_muted: '0', client_input_hardware: '1', client_output_hardware: '1', client_idle_time: '5000', client_created: '1700004000', client_lastconnected: '1700004200', client_version: '6.0.0', client_platform: 'Linux' },
  { clid: '6', cid: '4', client_database_id: '15', client_unique_identifier: 'unicode-user-uid', client_nickname: 'Unicode Test ✓', client_type: '0', client_country: 'XX', client_servergroups: '7', client_channel_group_id: '5', client_away: '0', client_away_message: '', client_flag_talking: '0', client_input_muted: '0', client_output_muted: '0', client_input_hardware: '1', client_output_hardware: '1', client_idle_time: '18000', client_created: '1700005000', client_lastconnected: '1700005200', client_version: '6.0.0', client_platform: 'Windows' },
  { clid: '7', cid: '5', client_database_id: '16', client_unique_identifier: 'music-bot-demo-uid', client_nickname: 'Demo Music Bot', client_type: '0', client_country: '', client_servergroups: '9', client_channel_group_id: '8', client_away: '0', client_away_message: '', client_flag_talking: '1', client_input_muted: '0', client_output_muted: '0', client_input_hardware: '1', client_output_hardware: '1', client_idle_time: '0', client_created: '1700006000', client_lastconnected: '1700006200', client_version: '6.0.0', client_platform: 'Linux' },
  { clid: '8', cid: '6', client_database_id: '17', client_unique_identifier: 'afk-user-uid', client_nickname: 'Away User', client_type: '0', client_country: 'XX', client_servergroups: '8', client_channel_group_id: '8', client_away: '1', client_away_message: 'Away', client_flag_talking: '0', client_input_muted: '1', client_output_muted: '1', client_input_hardware: '1', client_output_hardware: '1', client_idle_time: '3600000', client_created: '1700007000', client_lastconnected: '1700007200', client_version: '6.0.0', client_platform: 'Windows' },
  { clid: '99', cid: '1', client_database_id: '1', client_unique_identifier: 'serverquery-demo-uid', client_nickname: 'ServerQuery', client_type: '1', client_country: '', client_servergroups: '2', client_channel_group_id: '0', client_away: '0', client_away_message: '', client_flag_talking: '0', client_input_muted: '0', client_output_muted: '0', client_input_hardware: '1', client_output_hardware: '1', client_idle_time: '0', client_created: '1700008000', client_lastconnected: '1700008200', client_version: '6.0.0', client_platform: 'Linux' },
];

const DEMO_SERVER_GROUPS = [
  { sgid: '6', name: 'Server Admin', type: '1', iconid: '300', savedb: '1' },
  { sgid: '7', name: 'Moderator', type: '1', iconid: '301', savedb: '1' },
  { sgid: '8', name: 'Normal', type: '1', iconid: '0', savedb: '1' },
  { sgid: '9', name: 'Bot', type: '1', iconid: '302', savedb: '1' },
];

const DEMO_CHANNEL_GROUPS = [
  { cgid: '5', name: 'Channel Admin', type: '1', iconid: '200' },
  { cgid: '8', name: 'Guest', type: '1', iconid: '0' },
];

const DEMO_PERMISSIONS = [
  { permid: '1', permname: 'b_virtualserver_info_view', permdesc: 'View virtual server information' },
  { permid: '2', permname: 'b_virtualserver_channel_list', permdesc: 'List channels' },
  { permid: '3', permname: 'b_virtualserver_client_list', permdesc: 'List clients' },
  { permid: '4', permname: 'b_channel_create_permanent', permdesc: 'Create permanent channels' },
  { permid: '5', permname: 'b_channel_delete_permanent', permdesc: 'Delete permanent channels' },
  { permid: '6', permname: 'b_client_remoteaddress_view', permdesc: 'View client network address' },
  { permid: '7', permname: 'i_channel_modify_power', permdesc: 'Channel modification power' },
  { permid: '8', permname: 'i_client_kick_from_server_power', permdesc: 'Client kick power' },
  { permid: '9', permname: 'i_group_member_add_power', permdesc: 'Group member add power' },
  { permid: '10', permname: 'i_needed_modify_power_channel_name', permdesc: 'Required power to change channel name' },
];

const DEMO_PERMISSION_VALUES = [
  { permid: '1', permvalue: '1', permnegated: '0', permskip: '0' },
  { permid: '2', permvalue: '1', permnegated: '0', permskip: '0' },
  { permid: '4', permvalue: '75', permnegated: '0', permskip: '0' },
  { permid: '8', permvalue: '50', permnegated: '0', permskip: '0' },
];

const DEMO_BANS = [
  { banid: '1', ip: '203.0.113.25', name: 'Example Ban', uid: '', lastnickname: 'Example User', created: '1700000000', duration: '3600', invokername: 'Demo Admin', reason: 'Demonstration ban entry', enforcements: '1' },
];

const DEMO_TOKENS = [
  { token: 'DEMO-TOKEN-NOT-VALID', token_type: '0', token_id1: '8', token_id2: '0', token_created: '1700000000', token_description: 'Example privilege key' },
];

/** Newest-first virtual-server logfile rows with TeamSpeak-shaped last_pos cursors. */
const DEMO_VS_LOGS = [
  { last_pos: '500', file_size: '500', l: '2026-03-15 12:00:05.123456|INFO    |VirtualServer |1  |Virtual server started successfully.' },
  { last_pos: '400', file_size: '500', l: '2026-03-15 12:00:04.123456|WARNING |VirtualServer |1  |Client Sample User connected with an unusual client version.' },
  { last_pos: '300', file_size: '500', l: '2026-03-15 12:00:03.123456|ERROR   |VirtualServer |1  |Failed to open channel file transfer for cid=4.' },
  { last_pos: '200', file_size: '500', l: '2026-03-15 12:00:02.123456|DEBUG   |VirtualServer |1  |Permission cache refreshed for cldbid=12.' },
  { last_pos: '100', file_size: '500', l: 'not a structured line — Unicode ✓ and spaces\\spath' },
  { last_pos: '50', file_size: '500', l: '2026-03-15 12:00:00.000000|NOTICE  |VirtualServer |1  |Unrecognized level stays Unknown.' },
];

/** Instance/master logfile rows — must not be labeled as the selected VS. */
const DEMO_INSTANCE_LOGS = [
  { last_pos: '300', file_size: '300', l: '2026-03-15 11:59:00.000000|INFO    |ServerLibPriv |   |TeamSpeak instance started.' },
  { last_pos: '200', file_size: '300', l: '2026-03-15 11:58:00.000000|WARNING |Accounting    |   |License check deferred in demo mode.' },
  { last_pos: '100', file_size: '300', l: '2026-03-15 11:57:00.000000|INFO    |Query         |   |WebQuery listener ready.' },
];

function demoLogView(params?: Record<string, any>) {
  const instance = String(params?.instance ?? '0') === '1';
  const source = instance ? DEMO_INSTANCE_LOGS : DEMO_VS_LOGS;
  const fileSize = source[0]?.file_size ?? '0';
  const linesRaw = Number(params?.lines ?? 100);
  const lines = Number.isFinite(linesRaw)
    ? Math.min(100, Math.max(1, Math.trunc(linesRaw)))
    : 100;
  const beginRaw = params?.begin_pos;
  const beginPos = beginRaw === undefined || beginRaw === null || beginRaw === ''
    ? null
    : String(beginRaw);
  let rows = source;
  if (beginPos !== null && /^\d+$/.test(beginPos)) {
    const cursor = BigInt(beginPos);
    // Older page: rows whose last_pos is strictly below the continuation cursor.
    rows = source.filter((row) => BigInt(row.last_pos) < cursor);
  }
  return clone(rows.slice(0, lines).map((row) => ({ ...row, file_size: fileSize })));
}

const MUTATION_COMMANDS = new Set([
  'channelcreate', 'channeledit', 'channeldelete', 'channelmove',
  'channeladdperm', 'channeldelperm',
  'clientkick', 'banclient', 'clientmove', 'clientpoke', 'sendtextmessage',
  'clientaddperm', 'clientdelperm',
  'servergroupadd', 'servergrouprename', 'servergroupdel', 'servergroupcopy',
  'servergroupaddclient', 'servergroupdelclient', 'servergroupaddperm', 'servergroupdelperm',
  'channelgroupadd', 'channelgrouprename', 'channelgroupdel', 'setclientchannelgroup',
  'channelgroupaddperm', 'channelgroupdelperm',
  'banadd', 'bandel', 'bandelall',
  'privilegekeydelete', 'serveredit', 'servercreate', 'serverstart', 'serverstop',
  'serverdelete', 'serversnapshotcreate', 'serversnapshotdeploy', 'instanceedit',
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findClient(params?: Record<string, any>) {
  const id = String(params?.clid ?? params?.cldbid ?? '');
  return DEMO_CLIENTS.find((client) => client.clid === id || client.client_database_id === id);
}

export class DemoWebQueryClient extends WebQueryClient {
  constructor() {
    super(createValidatedTsServerEndpoint('127.0.0.1', 10080, false, 10080), 'demo-mode');
  }

  override async execute(
    _sid: number,
    command: string,
    params?: Record<string, any>,
  ): Promise<any> {
    switch (command) {
      case 'version':
        return clone(DEMO_VERSION);
      case 'serverlist':
        return clone(DEMO_SERVER_INFO);
      case 'serverinfo':
        return clone(DEMO_SERVER_INFO);
      case 'serverrequestconnectioninfo':
        return clone(DEMO_CONNECTION_INFO);
      case 'channellist':
        return clone(DEMO_CHANNELS);
      case 'channelinfo': {
        const channel = DEMO_CHANNELS.find((item) => item.cid === String(params?.cid));
        return channel ? [clone(channel)] : [];
      }
      case 'clientlist':
        return clone(DEMO_CLIENTS);
      case 'clientinfo': {
        const client = findClient(params);
        return client ? [clone(client)] : [];
      }
      case 'clientdblist':
        return clone(DEMO_CLIENTS.filter((client) => client.client_type === '0').map((client) => ({
          cldbid: client.client_database_id,
          client_database_id: client.client_database_id,
          client_unique_identifier: client.client_unique_identifier,
          client_nickname: client.client_nickname,
          client_created: client.client_created,
          client_lastconnected: client.client_lastconnected,
        })));
      case 'clientdbinfo': {
        const client = findClient(params);
        return client ? [clone({
          cldbid: client.client_database_id,
          client_database_id: client.client_database_id,
          client_unique_identifier: client.client_unique_identifier,
          client_nickname: client.client_nickname,
          client_created: client.client_created,
          client_lastconnected: client.client_lastconnected,
        })] : [];
      }
      case 'servergrouplist':
        return clone(DEMO_SERVER_GROUPS);
      case 'channelgrouplist':
        return clone(DEMO_CHANNEL_GROUPS);
      case 'servergroupclientlist': {
        const sgid = String(params?.sgid ?? '');
        return clone(DEMO_CLIENTS
          .filter((client) => client.client_type === '0' && String(client.client_servergroups).split(',').includes(sgid))
          .map((client) => ({
            cldbid: client.client_database_id,
            client_database_id: client.client_database_id,
            client_nickname: client.client_nickname,
            client_unique_identifier: client.client_unique_identifier,
          })));
      }
      case 'channelgroupclientlist':
        return clone(DEMO_CLIENTS.filter((client) => client.client_type === '0').map((client) => ({
          cldbid: client.client_database_id,
          cid: client.cid,
          cgid: client.client_channel_group_id,
          client_nickname: client.client_nickname,
        })));
      case 'servergroupsbyclientid': {
        const client = findClient(params);
        const ids = String(client?.client_servergroups ?? '').split(',');
        return clone(DEMO_SERVER_GROUPS.filter((group) => ids.includes(group.sgid)));
      }
      case 'permissionlist':
        return clone(DEMO_PERMISSIONS);
      case 'servergrouppermlist':
      case 'channelgrouppermlist':
      case 'channelpermlist':
      case 'clientpermlist':
      case 'permoverview':
        return clone(DEMO_PERMISSION_VALUES);
      case 'permidgetbyname': {
        const match = DEMO_PERMISSIONS.find((permission) => permission.permname === String(params?.permsid ?? ''));
        return match ? [{ permid: match.permid }] : [];
      }
      case 'permfind': {
        const permid = params?.permid ? String(params.permid) : null;
        const permsid = params?.permsid ? String(params.permsid) : null;
        return clone(DEMO_PERMISSIONS.filter((permission) =>
          (!permid || permission.permid === permid) && (!permsid || permission.permname.includes(permsid)),
        ));
      }
      case 'banlist':
        return clone(DEMO_BANS);
      case 'privilegekeylist':
        return clone(DEMO_TOKENS);
      case 'logview':
        return demoLogView(params);
      case 'instanceinfo':
        return [{
          serverinstance_database_version: 'demo',
          serverinstance_filetransfer_port: '30033',
          serverinstance_serverquery_flood_commands: '10',
          serverinstance_serverquery_flood_time: '3',
          serverinstance_serverquery_ban_time: '600',
        }];
      case 'hostinfo':
        return [{
          instance_uptime: '987654',
          host_timestamp_utc: String(Math.floor(Date.now() / 1000)),
          virtualservers_running_total: '1',
          virtualservers_total_maxclients: '64',
          virtualservers_total_clients_online: '8',
        }];
      case 'whoami':
        return [{ client_id: '99', client_database_id: '1', client_nickname: 'ServerQuery' }];
      case 'privilegekeyadd':
        return [{ token: 'DEMO-TOKEN-NOT-VALID' }];
      case 'servergroupadd':
        return [{ sgid: '99' }];
      case 'channelgroupadd':
        return [{ cgid: '99' }];
      case 'channelcreate':
        return [{ cid: '99' }];
      case 'servercreate':
        return [{ sid: '99', token: 'DEMO-TOKEN-NOT-VALID' }];
      case 'serversnapshotcreate':
        return [{ snapshot: 'DEMO-SNAPSHOT-NOT-VALID' }];
      default:
        if (MUTATION_COMMANDS.has(command)) {
          return [{ success: '1', demo: '1' }];
        }
        return [];
    }
  }

  override async executePost(
    sid: number,
    command: string,
    params?: Record<string, any>,
  ): Promise<any> {
    return this.execute(sid, command, params);
  }

  override async testConnection(): Promise<{ ok: true; version: unknown }> {
    return { ok: true, version: 'Demo mode' };
  }

  override async diagnoseConnection(
    _options?: DiagnoseConnectionOptions,
  ): Promise<ConnectionDiagnosticReport> {
    return buildFullSuccessReport('Demo mode');
  }

  override destroy(): void {
    super.destroy();
  }
}
