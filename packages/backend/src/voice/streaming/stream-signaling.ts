/**
 * TS6 Stream Signaling — handles stream protocol commands.
 *
 * Outgoing: setupstream, respondjoinstreamrequest, streamsignaling, stopstream, removeclientfromstream
 * Incoming: notifystreamstarted, notifystreamstopped, notifyjoinstreamrequest,
 *           notifyrespondjoinstreamrequest, notifystreamsignaling,
 *           notifystreamclientjoined, notifystreamclientleft, notifystreaminfo
 */

import { EventEmitter } from 'events';
import type { Ts3Client } from '../tslib/client.js';
import { buildCommand } from '../tslib/commands.js';

export interface ActiveStream {
  id: string;
  clid: number;
  name: string;
  type: number;
  access: number;
  mode: number;
  bitrate: number;
  viewerLimit: number;
  audio: boolean;
  startedAt: number;
}

export interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice_candidate' | 'reconnect' | 'stream_started' | 'stream_stopped' | 'join_response' | 'unknown';
  streamId?: string;
  clid?: number;
  sdp?: string;
  sdpMid?: string;
  sdpMlineIndex?: number;
  candidate?: string;
  isReconnect?: boolean;
  raw: string;
  stream?: ActiveStream;
}

export class StreamSignaling extends EventEmitter {
  private client: Ts3Client;
  private activeStreams: Map<string, ActiveStream> = new Map();
  private readonly onCommand = (parsed: any) => this.handleCommand(parsed);

  constructor(client: Ts3Client) {
    super();
    this.client = client;
    this.client.on('command', this.onCommand);
  }

  /**
   * Detach from the client and drop every listener. Without this each stream
   * start left a live command listener behind, so later join requests were
   * handled once per earlier stream.
   */
  dispose(): void {
    this.client.removeListener('command', this.onCommand);
    this.removeAllListeners();
    this.activeStreams.clear();
  }

  getActiveStreams(): Map<string, ActiveStream> {
    return new Map(this.activeStreams);
  }

  private handleCommand(parsed: any): void {
    switch (parsed.name) {
      case 'notifystreamstarted':
        this.handleStreamStarted(parsed);
        break;
      case 'notifystreamstopped':
        this.handleStreamStopped(parsed);
        break;
      case 'notifystreamsignaling':
        this.handleStreamSignaling(parsed);
        break;
      case 'notifyjoinstreamrequest':
        this.emit('joinStreamRequest', parsed.params);
        break;
      case 'notifyrespondjoinstreamrequest':
        this.handleJoinStreamResponse(parsed);
        break;
      case 'notifystreamclientjoined':
        this.emit('streamClientJoined', parsed.params);
        break;
      case 'notifystreamclientleft':
        this.emit('streamClientLeft', parsed.params);
        break;
      case 'notifystreaminfo':
        this.handleStreamInfo(parsed);
        break;
    }
  }

  private handleStreamStarted(parsed: any): void {
    const p = parsed.params;
    const stream: ActiveStream = {
      id: p.id || '',
      clid: parseInt(p.clid) || 0,
      name: p.name || '',
      type: parseInt(p.type) || 0,
      access: parseInt(p.access) || 0,
      mode: parseInt(p.mode) || 0,
      bitrate: parseInt(p.bitrate) || 0,
      viewerLimit: parseInt(p.viewer_limit) || 0,
      audio: p.audio === '1',
      startedAt: Date.now(),
    };
    this.activeStreams.set(stream.id, stream);
    this.emit('streamStarted', stream);
    this.emit('signalingMessage', {
      type: 'stream_started',
      streamId: stream.id,
      clid: stream.clid,
      raw: JSON.stringify(parsed),
      stream,
    } as SignalingMessage);
  }

  private handleStreamStopped(parsed: any): void {
    const streamId = parsed.params.id || parsed.params.stream_id || '';
    const stream = this.activeStreams.get(streamId);
    this.activeStreams.delete(streamId);
    this.emit('streamStopped', { streamId, stream });
    this.emit('signalingMessage', {
      type: 'stream_stopped',
      streamId,
      clid: parseInt(parsed.params.clid) || stream?.clid,
      raw: JSON.stringify(parsed),
      stream,
    } as SignalingMessage);
  }

  private handleStreamSignaling(parsed: any): void {
    const p = parsed.params;
    const dataStr = p.json || p.data || '';
    if (!dataStr) return;

    try {
      const payload = JSON.parse(dataStr);
      const cmd = payload.cmd;
      const args = payload.args || {};

      switch (cmd) {
        case 'offer':
        case 'reconnectOffer':
          this.emit('signalingMessage', {
            type: 'offer',
            sdp: args.offer || args.sdp,
            isReconnect: cmd === 'reconnectOffer',
            clid: parseInt(p.clid) || undefined,
            streamId: p.id || p.stream_id,
            raw: dataStr,
          } as SignalingMessage);
          break;
        case 'answer':
          this.emit('signalingMessage', {
            type: 'answer',
            sdp: args.answer || args.sdp,
            clid: parseInt(p.clid) || undefined,
            streamId: p.id || p.stream_id,
            raw: dataStr,
          } as SignalingMessage);
          break;
        case 'iceCandidate':
          this.emit('signalingMessage', {
            type: 'ice_candidate',
            candidate: args.sdp || args.candidate,
            sdpMid: args.mid || args.sdp_mid,
            sdpMlineIndex: args.mLine ?? args.sdp_mline_index,
            clid: parseInt(p.clid) || undefined,
            streamId: p.id || p.stream_id,
            raw: dataStr,
          } as SignalingMessage);
          break;
        case 'reconnect':
          this.emit('signalingMessage', {
            type: 'reconnect',
            isReconnect: true,
            clid: parseInt(p.clid) || undefined,
            streamId: p.id || p.stream_id,
            raw: dataStr,
          } as SignalingMessage);
          break;
      }
    } catch {
      console.warn(`[StreamSignaling] Failed to parse signaling JSON: ${dataStr.substring(0, 200)}`);
    }
  }

  private handleJoinStreamResponse(parsed: any): void {
    const p = parsed.params;
    const decision = parseInt(p.decision) || 0;

    if (decision === 1 && p.offer) {
      this.emit('signalingMessage', {
        type: 'offer',
        sdp: p.offer,
        clid: parseInt(p.clid) || undefined,
        streamId: p.id || p.stream_id,
        raw: JSON.stringify(p),
      } as SignalingMessage);
    } else {
      this.emit('signalingMessage', {
        type: 'join_response',
        clid: parseInt(p.clid) || undefined,
        streamId: p.id || p.stream_id,
        raw: JSON.stringify(p),
      } as SignalingMessage);
    }
  }

  private handleStreamInfo(parsed: any): void {
    const p = parsed.params;
    if (!p.id) return;

    const stream: ActiveStream = {
      id: p.id,
      clid: parseInt(p.clid) || 0,
      name: p.name || '',
      type: parseInt(p.type) || 0,
      access: parseInt(p.accessibility) || parseInt(p.access) || 0,
      mode: parseInt(p.mode) || 0,
      bitrate: parseInt(p.bitrate) || 0,
      viewerLimit: parseInt(p.viewer_limit) || 0,
      audio: p.audio === '1',
      startedAt: Date.now(),
    };
    this.activeStreams.set(stream.id, stream);
    this.emit('streamStarted', stream);
  }

  // --- Outgoing commands ---

  sendSetupStream(params: {
    name?: string;
    type?: number;
    bitrate?: number;
    accessibility?: number;
    mode?: number;
    viewerLimit?: number;
    audio?: boolean;
  } = {}): void {
    this.client.sendCommand(buildCommand('setupstream', {
      name: params.name || 'Bot Stream',
      type: String(params.type ?? 3),
      bitrate: String(params.bitrate ?? 4608),
      accessibility: String(params.accessibility ?? 1),
      mode: String(params.mode ?? 1),
      viewer_limit: String(params.viewerLimit ?? 0),
      audio: params.audio === false ? '0' : '1',
    }));
  }

  sendJoinResponse(viewerClid: number, streamId: string, accept: boolean = true, offerSdp?: string): void {
    this.client.sendCommand(buildCommand('respondjoinstreamrequest', {
      id: streamId,
      clid: String(viewerClid),
      msg: '',
      offer: offerSdp || '',
      decision: accept ? '1' : '0',
    }));
  }

  sendSignaling(targetClid: number, data: { cmd: string; args: Record<string, any> }, streamId?: string): void {
    this.client.sendCommand(buildCommand('streamsignaling', {
      id: streamId || '',
      clid: String(targetClid),
      json: JSON.stringify(data),
    }));
  }

  sendStreamStop(streamId: string, reason: number = 1): void {
    this.client.sendCommand(buildCommand('stopstream', { id: streamId, reason: String(reason) }));
  }

  sendRemoveClient(clid: number, streamId: string): void {
    this.client.sendCommand(buildCommand('removeclientfromstream', { id: streamId, clid: String(clid) }));
  }

  registerStreamNotifications(): void {
    for (const event of ['channel', 'server', 'textchannel']) {
      this.client.sendCommand(buildCommand('servernotifyregister', { event }));
    }
  }
}
