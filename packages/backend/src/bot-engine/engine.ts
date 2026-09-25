import type { PrismaClient } from '../../generated/prisma/index.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { EventBridge } from './event-bridge.js';
import { FlowRunner } from './flow-runner.js';
import type { Express, Request, Response } from 'express';
import type { WebSocketServer } from 'ws';
import { broadcastScoped } from '../ws/ws-session.js';
import cron from 'node-cron';
import type {
  FlowDefinition, FlowNode, FlowEdge,
  EventTriggerData, CronTriggerData, WebhookTriggerData, CommandTriggerData,
  AnimatedChannelActionData,
} from '@ts6/common';
import { AnimationManager } from './animation-manager.js';
import type { AnimationConfig } from './animation-manager.js';
import {
  applyAnimationFallbackToHoldInput,
  canArmBotsForPair,
  evaluateBotQueryReady,
} from './bot-query-ready.js';
import type { MusicCommandHandler } from '../voice/music-command-handler.js';
import crypto from 'crypto';

/** Max wait for EventBridge registration before arming WebQuery-only bots anyway. */
const BOT_ARM_FALLBACK_MS = 90_000;

/**
 * Normalize flow data from the frontend editor format to the engine format.
 *
 * Editor format:
 *   node: { id, type: "trigger_event"/"action_kick"/etc, label, config: { eventName, reason, ... }, x, y }
 *   edge: { id, source, sourcePort, target, targetPort }
 *
 * Engine format (matches @ts6/common types):
 *   node: { id, type: "trigger"/"action"/etc, position: {x,y}, data: { triggerType/actionType, label, ...config } }
 *   edge: { id, source, target, sourceHandle }
 *
 * Config field mappings:
 *   trigger_event:   { eventName } → { triggerType:'event', eventName }
 *   trigger_cron:    { cron } → { triggerType:'cron', cronExpression: cron }
 *   trigger_webhook: { path } → { triggerType:'webhook', webhookPath: path }
 *   trigger_command: { command } → { triggerType:'command', commandPrefix:'!', commandName: command }
 *   action_kick:     { reasonid, reason } → { actionType:'kick', reasonId: parseInt(reasonid)||5, reasonMsg: reason }
 *   action_ban:      { time, reason } → { actionType:'ban', duration: time, reason }
 *   action_move:     { channelId } → { actionType:'move', channelId }
 *   action_message:  { targetMode, message } → { actionType:'message', targetMode: modeMap, message }
 *   condition:       { expression } → { nodeType:'condition', expression }
 *   delay:           { delay } → { nodeType:'delay', delayMs: delay }
 *   variable:        { operation, name, value } → { nodeType:'variable', operation, variableName: name, value }
 *   log:             { level, message } → { nodeType:'log', level, message }
 */
function normalizeFlowData(raw: any): FlowDefinition {
  const targetModeMap: Record<string, number> = { client: 1, channel: 2, server: 3 };

  const nodes: FlowNode[] = (raw.nodes || []).map((n: any) => {
    const nodeType: string = n.type || '';

    // Already in engine format?
    if (n.data && (n.data.triggerType || n.data.actionType || n.data.nodeType)) {
      return { ...n, position: n.position || { x: n.x || 0, y: n.y || 0 } };
    }

    const config = n.config || {};
    const label = n.label || nodeType.replace(/_/g, ' ');
    const position = n.position || { x: n.x || 0, y: n.y || 0 };
    let type: string;
    let data: any;

    if (nodeType === 'trigger_event') {
      type = 'trigger';
      data = { triggerType: 'event', label, eventName: config.eventName || '', filters: config.filters };
    } else if (nodeType === 'trigger_cron') {
      type = 'trigger';
      data = { triggerType: 'cron', label, cronExpression: config.cron || config.cronExpression || '', timezone: config.timezone || undefined };
    } else if (nodeType === 'trigger_webhook') {
      type = 'trigger';
      data = { triggerType: 'webhook', label, webhookPath: config.path || config.webhookPath || '', method: config.method || 'POST', secret: config.secret || undefined };
    } else if (nodeType === 'trigger_command') {
      type = 'trigger';
      const cmd = config.command || '';
      const prefix = cmd.startsWith('!') ? '!' : config.commandPrefix || '!';
      const name = cmd.startsWith('!') ? cmd.substring(1) : cmd;
      data = { triggerType: 'command', label, commandPrefix: prefix, commandName: name, channelId: config.channelId ? String(config.channelId) : undefined, };
    } else if (nodeType === 'action_kick') {
      type = 'action';
      data = { actionType: 'kick', label, reasonId: parseInt(config.reasonid) || 5, reasonMsg: config.reason || '' };
    } else if (nodeType === 'action_ban') {
      type = 'action';
      data = { actionType: 'ban', label, duration: config.time || 0, reason: config.reason || '' };
    } else if (nodeType === 'action_move') {
      type = 'action';
      data = { actionType: 'move', label, channelId: config.channelId || config.cid || '' };
    } else if (nodeType === 'action_message') {
      type = 'action';
      data = { actionType: 'message', label, targetMode: targetModeMap[config.targetMode] || 1, message: config.message || '', target: config.target };
    } else if (nodeType === 'action_poke') {
      type = 'action';
      data = { actionType: 'poke', label, message: config.message || '' };
    } else if (nodeType === 'action_channelCreate') {
      type = 'action';
      const params: Record<string, string> = {};
      if (config.channel_name) params.channel_name = config.channel_name;
      if (config.cpid) params.cpid = config.cpid;
      const tmp = String(config.channel_flag_temporary ?? '');
      const semi = String(config.channel_flag_semi_permanent ?? '');
      if (tmp === '1') {
        params.channel_flag_temporary = '1';
      } else if (semi === '1') {
        params.channel_flag_semi_permanent = '1';
      }
      // If neither flag is '1', channel will be permanent (TS3 default)
      if (config.channel_topic) params.channel_topic = config.channel_topic;
      if (config.channel_password) params.channel_password = config.channel_password;
      data = { actionType: 'channelCreate', label, trackTempChannel: config.trackTempChannel === true || config.trackTempChannel === 'true', params: { ...params, ...config.params } };
    } else if (nodeType === 'action_channelEdit') {
      type = 'action';
      const params: Record<string, string> = {};
      if (config.channel_name) params.channel_name = config.channel_name;
      if (config.channel_topic) params.channel_topic = config.channel_topic;
      if (config.channel_description) params.channel_description = config.channel_description;
      if (config.channel_maxclients) params.channel_maxclients = config.channel_maxclients;
      if (config.channel_password) params.channel_password = config.channel_password;
      data = { actionType: 'channelEdit', label, channelId: config.channelId || config.cid || '', params: { ...params, ...config.params } };
    } else if (nodeType === 'action_channelDelete') {
      type = 'action';
      data = { actionType: 'channelDelete', label, channelId: config.channelId || config.cid || '', force: !!config.force };
    } else if (nodeType === 'action_groupAdd') {
      type = 'action';
      data = { actionType: 'groupAddClient', label, groupId: config.groupId || '' };
    } else if (nodeType === 'action_groupRemove') {
      type = 'action';
      data = { actionType: 'groupRemoveClient', label, groupId: config.groupId || '' };
    } else if (nodeType === 'action_webquery') {
      type = 'action';
      data = { actionType: 'webquery', label, command: config.command || '', params: config.params || {}, storeAs: config.storeAs || undefined };
    } else if (nodeType === 'action_webhook') {
      type = 'action';
      data = { actionType: 'webhook', label, url: config.url || '', method: config.method || 'POST', headers: config.headers, body: config.body, storeAs: config.storeAs || undefined };
    } else if (nodeType === 'action_httpRequest') {
      type = 'action';
      data = { actionType: 'httpRequest', label, url: config.url || '', method: config.method || 'GET', headers: config.headers, body: config.body, storeAs: config.storeAs || undefined };
    } else if (nodeType === 'action_afkMover') {
      type = 'action';
      data = { actionType: 'afkMover', label, afkChannelId: config.afkChannelId || '', idleThresholdSeconds: parseInt(config.idleThresholdSeconds) || 300, exemptGroupIds: config.exemptGroupIds || '' };
    } else if (nodeType === 'action_idleKicker') {
      type = 'action';
      data = { actionType: 'idleKicker', label, idleThresholdSeconds: parseInt(config.idleThresholdSeconds) || 1800, reason: config.reason || '', exemptGroupIds: config.exemptGroupIds || '' };
    } else if (nodeType === 'action_pokeGroup') {
      type = 'action';
      data = { actionType: 'pokeGroup', label, groupId: config.groupId || '', message: config.message || '' };
    } else if (nodeType === 'action_rankCheck') {
      type = 'action';
      data = { actionType: 'rankCheck', label, ranks: config.ranks || '[]' };
    } else if (nodeType === 'action_tempChannelCleanup') {
      type = 'action';
      data = { actionType: 'tempChannelCleanup', label, parentChannelId: config.parentChannelId || '', protectedChannelIds: config.protectedChannelIds || '' };
    } else if (nodeType === 'action_voicePlay') {
      type = 'action';
      data = { actionType: 'voicePlay', label, botId: config.botId || '', songId: config.songId || '', playlistId: config.playlistId || '' };
    } else if (nodeType === 'action_voiceStop') {
      type = 'action';
      data = { actionType: 'voiceStop', label, botId: config.botId || '' };
    } else if (nodeType === 'action_voiceJoinChannel') {
      type = 'action';
      data = { actionType: 'voiceJoinChannel', label, botId: config.botId || '', channelId: config.channelId || '', channelPassword: config.channelPassword || '' };
    } else if (nodeType === 'action_voiceLeaveChannel') {
      type = 'action';
      data = { actionType: 'voiceLeaveChannel', label, botId: config.botId || '' };
    } else if (nodeType === 'action_voiceVolume') {
      type = 'action';
      data = { actionType: 'voiceVolume', label, botId: config.botId || '', volume: config.volume || '50' };
    } else if (nodeType === 'action_voicePauseResume') {
      type = 'action';
      data = { actionType: 'voicePauseResume', label, botId: config.botId || '', action: config.action || 'toggle' };
    } else if (nodeType === 'action_voiceSkip') {
      type = 'action';
      data = { actionType: 'voiceSkip', label, botId: config.botId || '', direction: config.direction || 'next' };
    } else if (nodeType === 'action_voiceSeek') {
      type = 'action';
      data = { actionType: 'voiceSeek', label, botId: config.botId || '', position: config.position || '0' };
    } else if (nodeType === 'action_voiceTts') {
      type = 'action';
      data = { actionType: 'voiceTts', label, botId: config.botId || '', text: config.text || '', language: config.language || '' };
    } else if (nodeType === 'action_animatedChannel') {
      type = 'action';
      data = {
        actionType: 'animatedChannel',
        label,
        channelId: config.channelId || '',
        text: config.text || '',
        style: config.style || 'scroll',
        intervalSeconds: config.intervalSeconds || '10',
        prefix: config.prefix || '[cspacer]',
        suppressEditEvents: config.suppressEditEvents !== false && config.suppressEditEvents !== 'false',
      };
    } else if (nodeType === 'condition') {
      type = 'condition';
      data = { nodeType: 'condition', label, expression: config.expression || '' };
    } else if (nodeType === 'delay') {
      type = 'delay';
      data = { nodeType: 'delay', label, delayMs: config.delay || config.delayMs || 1000 };
    } else if (nodeType === 'variable') {
      type = 'variable';
      data = { nodeType: 'variable', label, operation: config.operation || 'set', variableName: config.name || '', value: config.value || '' };
    } else if (nodeType === 'action_generateCode') { 
      type = 'action'; 
      data = { actionType: 'generateCode', label, length: parseInt(config.length, 10) || 5, storeAs: config.storeAs || 'code', numericOnly: config.numericOnly !== false, };
    } else if (nodeType === 'log') {
      type = 'log';
      data = { nodeType: 'log', label, level: config.level || 'info', message: config.message || '' };
    } else {
      // Pass through unknown types
      type = nodeType;
      data = { label, ...config };
    }

    return { id: n.id, type, position, data } as FlowNode;
  });

  const edges: FlowEdge[] = (raw.edges || []).map((e: any) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle || e.sourcePort || undefined,
    label: e.label || undefined,
  }));

  return { nodes, edges };
}

interface LoadedFlow {
  id: number;
  name: string;
  serverConfigId: number;
  virtualServerId: number;
  flowData: FlowDefinition;
  triggerNodes: FlowNode[];
}

interface CronEntry {
  flowId: number;
  nodeId: string;
  task: cron.ScheduledTask;
}

interface WebhookEntry {
  flowId: number;
  nodeId: string;
  path: string;
  method: string;
  secret?: string;
}

const MAX_CONCURRENT_PER_FLOW = 20;

export class BotEngine {
  private flows: Map<number, LoadedFlow> = new Map();
  private eventBridge: EventBridge;
  private flowRunner: FlowRunner;
  private animationManager: AnimationManager;
  private cronJobs: CronEntry[] = [];
  private webhookEntries: WebhookEntry[] = [];
  private executionCounts: Map<number, number> = new Map();
  private running: boolean = false;
  private musicCommandHandler: MusicCommandHandler | null = null;
  /** Stable listener so stop() does not wipe journal/music tsEvent subscribers. */
  private readonly onTsEventBound = (
    configId: number,
    sid: number,
    eventName: string,
    data: Record<string, string>,
  ) => this.onTsEvent(configId, sid, eventName, data);
  /** Pairs currently retained under the `flow` session owner. */
  private flowOwnedPairs = new Set<string>();
  /** Pairs that expect SSH event registration (connected or connecting with credentials). */
  private sshExpectedPairs = new Set<string>();
  /** Pairs whose animations have been armed (started) for the current engine run. */
  private animationsArmedPairs = new Set<string>();
  /**
   * Pairs allowed to arm/tick animations after the 90s registration fallback.
   * Does not relax cron readiness — that stays gated on EventBridge registration.
   */
  private animationFallbackPairs = new Set<string>();
  /** Fallback timers when registerEvents never completes. */
  private botArmFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly onSshConnectedBound = (configId: number, sid: number) => {
    this.sshExpectedPairs.add(`${configId}:${sid}`);
    this.armBotsForPairIfReady(configId, sid);
  };
  private readonly onSshDisconnectedBound = (configId: number, sid: number) => {
    // Keep expectsSsh — reconnect will re-register; animation ticks hold via getQueryHoldMs.
    console.log(`[BotEngine] SSH disconnected for ${configId}:${sid} — pausing cosmetic channel edits until events re-register`);
  };

  constructor(
    private prisma: PrismaClient,
    private connectionPool: ConnectionPool,
    private wss: WebSocketServer,
    private app: Express,
  ) {
    this.eventBridge = new EventBridge(prisma);
    this.flowRunner = new FlowRunner(prisma, connectionPool, wss);
    this.animationManager = new AnimationManager();
  }

  setVoiceBotManager(manager: any): void {
    this.flowRunner.setVoiceBotManager(manager);
  }

  setMusicCommandHandler(handler: MusicCommandHandler): void {
    this.musicCommandHandler = handler;
    // Music bots may need SSH (command listeners / auto-discovery) even with no flows.
    if (this.running) {
      void this.syncSessionOwnership();
    }
  }

  getEventBridge(): EventBridge {
    return this.eventBridge;
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Always register event listener (even if no flows yet — flows can be enabled later)
    this.eventBridge.on('tsEvent', this.onTsEventBound);
    this.eventBridge.on('sshConnected', this.onSshConnectedBound);
    this.eventBridge.on('sshDisconnected', this.onSshDisconnectedBound);

    await this.loadFlows();

    if (this.flows.size === 0) {
      console.log('[BotEngine] No enabled flows found, engine idle (will activate when flows are enabled)');
      this.running = true;
      // Music (and later journal) may still need SSH — sync ownership without assuming flows.
      await this.syncSessionOwnership();
      return;
    }

    // Setup SSH connections for all unique server+vserver pairs (non-blocking)
    await this.syncSessionOwnership();

    // Setup cron jobs (callbacks gate on EventBridge readiness)
    this.setupCronJobs();

    // Build webhook registry
    this.buildWebhookRegistry();

    // Defer animations until registerEvents finishes (or no-SSH / fallback).
    // Starting on SSH `ready` while registerEvents is still async causes WebQuery
    // channeledit + servernotifyregister to collide on instance antiflood.
    for (const flow of this.flows.values()) {
      this.scheduleBotsWhenReady(flow.serverConfigId, flow.virtualServerId);
    }

    this.running = true;

    const sshCount = this.eventBridge.getConnectedKeys().length;
    console.log(`[BotEngine] Started with ${this.flows.size} flow(s), ${sshCount} SSH connection(s), ${this.cronJobs.length} cron job(s), ${this.webhookEntries.length} webhook(s)`);

    this.broadcast('bot:engine:started', { flowCount: this.flows.size });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.animationManager.stopAll();
    this.teardownCronJobs();
    this.clearBotArmFallbacks();
    this.animationsArmedPairs.clear();
    this.animationFallbackPairs.clear();
    this.sshExpectedPairs.clear();
    this.webhookEntries = [];
    this.eventBridge.off('tsEvent', this.onTsEventBound);
    this.eventBridge.off('sshConnected', this.onSshConnectedBound);
    this.eventBridge.off('sshDisconnected', this.onSshDisconnectedBound);
    this.flows.clear();
    this.executionCounts.clear();
    // Release only flow ownership — music/journal consumers keep their sessions.
    for (const pair of [...this.flowOwnedPairs]) {
      const [configId, sid] = pair.split(':').map(Number);
      await this.eventBridge.releaseSession('flow', configId, sid);
    }
    this.flowOwnedPairs.clear();
  }

  async enableFlow(flowId: number): Promise<void> {
    console.log(`[BotEngine] Enabling flow ${flowId}...`);
    const dbFlow = await this.prisma.botFlow.findUnique({ where: { id: flowId } });
    if (!dbFlow || !dbFlow.enabled) {
      console.log(`[BotEngine] Flow ${flowId} not found or not enabled in DB`);
      return;
    }

    try {
      const raw = JSON.parse(dbFlow.flowData);
      const flowData = normalizeFlowData(raw);
      const triggerNodes = flowData.nodes.filter(n => n.type === 'trigger');

      const hasAnimations = flowData.nodes.some(n => n.type === 'action' && (n.data as any).actionType === 'animatedChannel');
      console.log(`[BotEngine] Flow ${flowId} ('${dbFlow.name}'): ${triggerNodes.length} trigger(s), ${flowData.nodes.length} node(s), ${flowData.edges.length} edge(s)${hasAnimations ? ', has animations' : ''}`);

      if (triggerNodes.length === 0 && !hasAnimations) {
        console.warn(`[BotEngine] Flow ${flowId} has no trigger nodes and no animations — nothing to activate`);
      }

      for (const t of triggerNodes) {
        const td = t.data as any;
        console.log(`[BotEngine]   Trigger: type=${td.triggerType}, ${td.triggerType === 'event' ? `event=${td.eventName}` : td.triggerType === 'cron' ? `cron=${td.cronExpression}` : td.triggerType === 'command' ? `cmd=${td.commandPrefix}${td.commandName}` : `webhook=${td.webhookPath}`}`);
      }

      this.flows.set(flowId, {
        id: dbFlow.id,
        name: dbFlow.name,
        serverConfigId: dbFlow.serverConfigId,
        virtualServerId: dbFlow.virtualServerId,
        flowData,
        triggerNodes,
      });

      // Ensure SSH connection exists for event/command triggers
      const hasEventTrigger = triggerNodes.some(t => {
        const td = t.data as any;
        return td.triggerType === 'event' || td.triggerType === 'command';
      });

      if (hasEventTrigger) {
        console.log(`[BotEngine] Flow needs SSH — retaining session for server ${dbFlow.serverConfigId}, sid=${dbFlow.virtualServerId}...`);
        await this.syncSessionOwnership();
        // NEW: start/stop per-channel command listeners for this pair
        this.syncCommandListenersForPair(dbFlow.serverConfigId, dbFlow.virtualServerId);
      }

      // Setup cron jobs for this flow
      this.setupCronJobsForFlow(flowId);

      // Add webhook entries for this flow
      this.buildWebhookRegistryForFlow(flowId);

      // Defer animations until EventBridge events are registered for this pair.
      this.scheduleBotsWhenReady(dbFlow.serverConfigId, dbFlow.virtualServerId, flowId);

      console.log(`[BotEngine] Flow ${flowId} ('${dbFlow.name}') enabled successfully`);
    } catch (err: any) {
      console.error(`[BotEngine] Failed to enable flow ${flowId}: ${err.message}`);
    }
  }

  async disableFlow(flowId: number): Promise<void> {
    this.animationManager.stopAnimation(flowId);
    this.teardownCronJobs(flowId);
    this.webhookEntries = this.webhookEntries.filter(w => w.flowId !== flowId);
    this.flows.delete(flowId);
    this.executionCounts.delete(flowId);

    // Check if any remaining flows use the same SSH connections
    await this.cleanupUnusedSshConnections();

    console.log(`[BotEngine] Flow ${flowId} disabled`);
  }

  async reloadFlow(flowId: number): Promise<void> {
    const flow = this.flows.get(flowId);
    if (flow) {
      // Flow was active — disable then re-enable
      await this.disableFlow(flowId);
      const dbFlow = await this.prisma.botFlow.findUnique({ where: { id: flowId } });
      if (dbFlow?.enabled) {
        await this.enableFlow(flowId);
      }
    }
  }

  handleWebhookRequest(req: Request, res: Response): void {
    const webhookPath = String(req.params.path || req.params[0] || '');
    const method = req.method.toUpperCase();
    const providedSecret = String(req.headers['x-webhook-secret'] || req.query.secret || '');

    const matching = this.webhookEntries.filter(w =>
      w.path === webhookPath && (w.method === method || w.method === 'ANY')
    );

    // H6: Return same 404 for not-found and invalid-secret (prevent enumeration)
    if (matching.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    let triggered = 0;
    for (const wh of matching) {
      // H6: Mandatory webhook secrets — skip webhooks without secrets configured
      if (!wh.secret) continue;

      // H6: Timing-safe secret comparison
      const secretBuf = Buffer.from(wh.secret);
      const providedBuf = Buffer.from(providedSecret);
      if (secretBuf.length !== providedBuf.length || !crypto.timingSafeEqual(secretBuf, providedBuf)) {
        continue;
      }

      const flow = this.flows.get(wh.flowId);
      if (!flow) continue;

      const webhookData: Record<string, string> = {
        webhook_path: webhookPath,
        webhook_method: method,
        webhook_body: JSON.stringify(req.body || {}),
        webhook_query: JSON.stringify(req.query || {}),
      };

      this.executeFlow(flow, wh.nodeId, 'webhook', webhookData);
      triggered++;
    }

    // Same response regardless of reason (not found / wrong secret)
    if (triggered === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.json({ triggered });
  }

  getFlow(flowId: number): LoadedFlow | undefined {
    return this.flows.get(flowId);
  }

  async destroy(): Promise<void> {
    await this.stop();
    await this.eventBridge.destroy();
    this.broadcast('bot:engine:stopped', {});
  }

  // --- Private Methods ---

  private async loadFlows(): Promise<void> {
    const dbFlows = await this.prisma.botFlow.findMany({ where: { enabled: true } });

    for (const dbFlow of dbFlows) {
      try {
        const raw = JSON.parse(dbFlow.flowData);
        const flowData = normalizeFlowData(raw);
        const triggerNodes = flowData.nodes.filter(n => n.type === 'trigger');
        const hasAnimations = flowData.nodes.some(n => n.type === 'action' && (n.data as any).actionType === 'animatedChannel');

        if (triggerNodes.length === 0 && !hasAnimations) {
          console.warn(`[BotEngine] Flow ${dbFlow.id} ('${dbFlow.name}') has no trigger nodes and no animations, skipping`);
          continue;
        }

        this.flows.set(dbFlow.id, {
          id: dbFlow.id,
          name: dbFlow.name,
          serverConfigId: dbFlow.serverConfigId,
          virtualServerId: dbFlow.virtualServerId,
          flowData,
          triggerNodes,
        });
      } catch (err: any) {
        console.error(`[BotEngine] Failed to parse flow ${dbFlow.id}: ${err.message}`);
      }
    }
  }

  private getNeededFlowPairs(): Set<string> {
    const pairs = new Set<string>();
    for (const flow of this.flows.values()) {
      pairs.add(`${flow.serverConfigId}:${flow.virtualServerId}`);
    }
    return pairs;
  }

  private getNeededMusicPairs(): Set<string> {
    const pairs = new Set<string>();
    if (this.musicCommandHandler) {
      for (const pair of this.musicCommandHandler.getNeededServerPairs()) {
        pairs.add(pair);
      }
    }
    return pairs;
  }

  /** @deprecated Prefer syncSessionOwnership — kept for call-site clarity during transition. */
  private getNeededServerPairs(): Set<string> {
    return new Set([...this.getNeededFlowPairs(), ...this.getNeededMusicPairs()]);
  }

  /**
   * Retain/release flow session owners without stealing music/journal sessions.
   * Disconnect happens only when EventBridge has no remaining owners.
   */
  private async syncSessionOwnership(): Promise<void> {
    const flowNeeded = this.getNeededFlowPairs();
    const musicNeeded = this.getNeededMusicPairs();

    for (const pair of flowNeeded) {
      if (this.flowOwnedPairs.has(pair)) continue;
      const [configId, sid] = pair.split(':').map(Number);
      try {
        // retainSession returns whether SSH credentials are configured (not current
        // isConnected/isRegistered). Pairs without credentials stay WebQuery-only.
        const sshConfigured = await this.eventBridge.retainSession('flow', configId, sid);
        this.flowOwnedPairs.add(pair);
        if (sshConfigured) {
          this.sshExpectedPairs.add(pair);
        }
      } catch (err: any) {
        console.error(`[BotEngine] Flow session retain failed for ${pair}: ${err.message}`);
      }
    }
    for (const pair of [...this.flowOwnedPairs]) {
      if (flowNeeded.has(pair)) continue;
      const [configId, sid] = pair.split(':').map(Number);
      await this.eventBridge.releaseSession('flow', configId, sid);
      this.flowOwnedPairs.delete(pair);
      this.sshExpectedPairs.delete(pair);
      this.animationsArmedPairs.delete(pair);
      this.animationFallbackPairs.delete(pair);
      this.clearBotArmFallback(pair);
    }

    // Music owns its own retains via MusicCommandHandler; we only sync CMD listeners here.
    const allNeeded = new Set([...flowNeeded, ...musicNeeded]);
    for (const pair of allNeeded) {
      const [configId, sid] = pair.split(':').map(Number);
      this.syncCommandListenersForPair(configId, sid);
    }

    for (const cmdKey of this.eventBridge.getCommandListenerKeys()) {
      const m = cmdKey.match(/^(\d+):(\d+):cmd:(\d+)$/);
      if (!m) continue;
      const configId = Number(m[1]);
      const sid = Number(m[2]);
      const channelId = Number(m[3]);
      const pairKey = `${configId}:${sid}`;
      if (!allNeeded.has(pairKey)) {
        await this.eventBridge.disconnectCommandListener(configId, sid, channelId);
      }
    }
  }

  private setupSshConnections(): void {
    void this.syncSessionOwnership();
  }

  private async cleanupUnusedSshConnections(): Promise<void> {
    await this.syncSessionOwnership();
  }

  private onTsEvent(configId: number, sid: number, eventName: string, data: Record<string, string>): void {
    // Animated Channel renames fire notifychanneledited every tick — optionally ignore them.
    if (eventName === 'notifychanneledited' && data.cid && this.animationManager.isChannelEditSuppressed(sid, data.cid)) {
      return;
    }

    console.log(`[BotEngine] TS Event received: ${eventName} from ${configId}:${sid}`, JSON.stringify(data).substring(0, 200));
    for (const flow of this.flows.values()) {
      if (flow.serverConfigId !== configId || flow.virtualServerId !== sid) continue;

      for (const triggerNode of flow.triggerNodes) {
        const triggerData = triggerNode.data as any;

        // Event trigger
        if (triggerData.triggerType === 'event') {
          const eventTrigger = triggerData as EventTriggerData;
          if (eventTrigger.eventName !== eventName) {
            continue;
          }

          // Apply filters
          if (eventTrigger.filters) {
            let matches = true;
            for (const [key, value] of Object.entries(eventTrigger.filters)) {
              if (data[key] !== value) { matches = false; break; }
            }
            if (!matches) continue;
          }

          this.executeFlow(flow, triggerNode.id, 'event', data);
        }

        // Command trigger (special case of text message)
        if (triggerData.triggerType === 'command' && eventName === 'notifytextmessage') {
          const cmdTrigger = triggerData as CommandTriggerData;

          // Backward-compat:
          // - if trigger has NO channelId => only react to base connection events
          // - if trigger HAS channelId => only react if event came from that cmd listener OR matches target
          const sourceListenerCid = data.__cmd_listener_channel_id;

          if (!cmdTrigger.channelId) {
            if (sourceListenerCid) continue;
          } else {
            const required = String(cmdTrigger.channelId);

            // For channel-specific commands: only accept events coming from the dedicated cmd listener
            if (!sourceListenerCid) continue;
            if (sourceListenerCid !== required) continue;
          }

          const msg = data.msg || '';
          const fullCommand = (cmdTrigger.commandPrefix || '!') + cmdTrigger.commandName;
          if (!msg.startsWith(fullCommand)) continue;

          const afterCmd = msg.substring(fullCommand.length);
          if (afterCmd.length > 0 && afterCmd[0] !== ' ') continue;

          const args = afterCmd.trim();
          const argsParts = args.length > 0 ? args.split(/\s+/).filter(Boolean) : [];
          const enrichedData = {
            ...data,
            command_args: args,
            command_args_list: JSON.stringify(argsParts),
            command_name: cmdTrigger.commandName,
            command_channel_id: data.__cmd_listener_channel_id || cmdTrigger.channelId || data.target || '',
          };

          const invoker =
            data.clid ||
            data.invokerid ||
            data.invoker_id ||
            data.invokerId ||
            data.client_id ||
            data.clientId;

          if (invoker && !data.clid) {

            (enrichedData as any).clid = String(invoker);
          }

          this.executeFlow(flow, triggerNode.id, 'command', enrichedData);
        }
      }
    }
  }


  private getNeededCommandChannelIds(configId: number, sid: number): number[] {
    const ids = new Set<number>();

    for (const flow of this.flows.values()) {
      if (flow.serverConfigId !== configId || flow.virtualServerId !== sid) continue;

      for (const t of flow.triggerNodes) {
        const td: any = t.data;
        if (td?.triggerType === 'command' && td.channelId) {
          const n = parseInt(String(td.channelId), 10);
          if (Number.isFinite(n) && n > 0) ids.add(n);
        }
      }
    }

    // Music commands use the main EventBridge SSH roaming helper — do not open
    // per-channel CMD listener sessions for music (Query 524 flood on bot join).

    return Array.from(ids);
  }

  private syncCommandListenersForPair(configId: number, sid: number): void {
    const needed = new Set(this.getNeededCommandChannelIds(configId, sid));
    const existing = new Set(this.eventBridge.getCommandListenerChannelIds(configId, sid));

    for (const cid of needed) {
      if (!existing.has(cid)) {
        this.eventBridge.connectCommandListener(configId, sid, cid).catch(err => {
          console.error(`[BotEngine] CMD listener connect failed for ${configId}:${sid}:${cid}: ${err.message}`);
        });
      }
    }

    for (const cid of existing) {
      if (!needed.has(cid)) {
        this.eventBridge.disconnectCommandListener(configId, sid, cid).catch(() => { });
      }
    }
  }


  private executeFlow(flow: LoadedFlow, triggerNodeId: string, triggerType: string, eventData: Record<string, string>): void {
    console.log(`[BotEngine] Executing flow ${flow.id} ('${flow.name}') triggered by ${triggerType}`);

    // Rate limiting
    const current = this.executionCounts.get(flow.id) || 0;
    if (current >= MAX_CONCURRENT_PER_FLOW) {
      console.warn(`[BotEngine] Flow ${flow.id} rate limited (${current} concurrent executions)`);
      return;
    }
    this.executionCounts.set(flow.id, current + 1);

    // Extract timezone from the trigger node (if cron trigger has one)
    const triggerNode = flow.flowData.nodes.find(n => n.id === triggerNodeId);
    const triggerData = triggerNode?.data as any;
    const timezone = triggerData?.timezone as string | undefined;

    this.flowRunner.execute(flow, triggerNodeId, triggerType, eventData, timezone)
      .catch(err => {
        console.error(`[BotEngine] Flow ${flow.id} execution error: ${err.message}`);
      })
      .finally(() => {
        const count = this.executionCounts.get(flow.id) || 1;
        this.executionCounts.set(flow.id, count - 1);
      });
  }

  private setupCronJobs(): void {
    for (const flow of this.flows.values()) {
      this.setupCronJobsForFlow(flow.id);
    }
  }

  private setupCronJobsForFlow(flowId: number): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;

    for (const triggerNode of flow.triggerNodes) {
      const triggerData = triggerNode.data as any;
      if (triggerData.triggerType !== 'cron') continue;

      const cronData = triggerData as CronTriggerData;
      if (!cron.validate(cronData.cronExpression)) {
        console.error(`[BotEngine] Invalid cron expression '${cronData.cronExpression}' in flow ${flowId}`);
        continue;
      }

      const task = cron.schedule(cronData.cronExpression, () => {
        if (!this.isPairReadyForBotTraffic(flow.serverConfigId, flow.virtualServerId)) {
          console.log(
            `[BotEngine] Skipping cron for flow ${flowId} — EventBridge/Query not ready for ${flow.serverConfigId}:${flow.virtualServerId}`,
          );
          return;
        }
        this.executeFlow(flow, triggerNode.id, 'cron', {});
      }, {
        timezone: cronData.timezone || 'UTC',
      });

      this.cronJobs.push({ flowId, nodeId: triggerNode.id, task });
    }
  }

  private buildWebhookRegistry(): void {
    for (const flow of this.flows.values()) {
      this.buildWebhookRegistryForFlow(flow.id);
    }
  }

  private buildWebhookRegistryForFlow(flowId: number): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;

    for (const triggerNode of flow.triggerNodes) {
      const triggerData = triggerNode.data as any;
      if (triggerData.triggerType !== 'webhook') continue;

      const whData = triggerData as WebhookTriggerData;
      this.webhookEntries.push({
        flowId,
        nodeId: triggerNode.id,
        path: whData.webhookPath,
        method: whData.method || 'POST',
        secret: whData.secret || undefined,
      });
    }
  }

  private teardownCronJobs(flowId?: number): void {
    const toRemove = flowId !== undefined
      ? this.cronJobs.filter(j => j.flowId === flowId)
      : this.cronJobs;

    for (const entry of toRemove) {
      entry.task.stop();
    }

    this.cronJobs = flowId !== undefined
      ? this.cronJobs.filter(j => j.flowId !== flowId)
      : [];
  }

  private scheduleBotsWhenReady(configId: number, sid: number, flowId?: number): void {
    const key = `${configId}:${sid}`;
    this.armBotsForPairIfReady(configId, sid, { flowId });
    if (this.animationsArmedPairs.has(key)) return;

    // Already waiting on sshConnected; arm a fallback so WebQuery-only / stuck
    // registration cannot leave animations silent forever.
    if (!this.botArmFallbackTimers.has(key)) {
      const timer = setTimeout(() => {
        this.botArmFallbackTimers.delete(key);
        if (this.animationsArmedPairs.has(key)) return;
        console.warn(
          `[BotEngine] Arming animations for ${key} after ${BOT_ARM_FALLBACK_MS}ms without EventBridge registration`,
        );
        // Animation-only escape hatch — do not clear sshExpectedPairs (cron stays gated).
        this.animationFallbackPairs.add(key);
        this.armBotsForPairIfReady(configId, sid, { force: true });
      }, BOT_ARM_FALLBACK_MS);
      timer.unref?.();
      this.botArmFallbackTimers.set(key, timer);
    }
  }

  private armBotsForPairIfReady(
    configId: number,
    sid: number,
    opts?: { force?: boolean; flowId?: number },
  ): void {
    const key = `${configId}:${sid}`;
    const input = this.botQueryReadyInput(configId, sid);
    if (!opts?.force && !canArmBotsForPair(input)) {
      if (!this.animationsArmedPairs.has(key)) {
        console.log(
          `[BotEngine] Deferring animations for ${key} until EventBridge events are registered`,
        );
      }
      return;
    }

    const firstArm = !this.animationsArmedPairs.has(key);
    this.animationsArmedPairs.add(key);
    this.clearBotArmFallback(key);

    for (const flow of this.flows.values()) {
      if (flow.serverConfigId !== configId || flow.virtualServerId !== sid) continue;
      // On first arm start every flow on the pair; later enableFlow passes flowId.
      if (opts?.flowId !== undefined && !firstArm && flow.id !== opts.flowId) continue;
      this.startAnimationsForFlow(flow.id, configId, sid);
    }
    if (firstArm) {
      console.log(`[BotEngine] Armed bot channel-edit traffic for ${key}`);
    }
  }

  private botQueryReadyInput(configId: number, sid: number) {
    const key = `${configId}:${sid}`;
    return {
      isRegistered: this.eventBridge.isRegistered(configId, sid),
      isConnected: this.eventBridge.isConnected(configId, sid),
      sshReconnectPauseMs: this.eventBridge.getSshReconnectPauseSeconds(configId, sid) * 1000,
      expectsSshRegistration: this.sshExpectedPairs.has(key),
    };
  }

  private isPairReadyForBotTraffic(configId: number, sid: number): boolean {
    return evaluateBotQueryReady(this.botQueryReadyInput(configId, sid)).ready;
  }

  private getQueryHoldMsForPair(configId: number, sid: number): number {
    const input = this.botQueryReadyInput(configId, sid);
    const holdInput = applyAnimationFallbackToHoldInput(
      input,
      this.animationFallbackPairs.has(`${configId}:${sid}`),
    );
    return evaluateBotQueryReady(holdInput).holdMs;
  }

  private clearBotArmFallback(key: string): void {
    const timer = this.botArmFallbackTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.botArmFallbackTimers.delete(key);
    }
  }

  private clearBotArmFallbacks(): void {
    for (const key of [...this.botArmFallbackTimers.keys()]) {
      this.clearBotArmFallback(key);
    }
  }

  private startAnimationsForFlow(flowId: number, serverConfigId: number, virtualServerId: number): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;

    const animNodes = flow.flowData.nodes.filter(
      n => n.type === 'action' && (n.data as any).actionType === 'animatedChannel'
    );

    if (animNodes.length === 0) return;

    try {
      const client = this.connectionPool.getClient(serverConfigId);

      for (const node of animNodes) {
        const d = node.data as AnimatedChannelActionData;
        const parsedInterval = parseFloat(String(d.intervalSeconds));
        const config: AnimationConfig = {
          channelId: d.channelId,
          text: d.text,
          style: d.style || 'scroll',
          intervalSeconds: Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 10,
          prefix: d.prefix || '[cspacer]',
          suppressEditEvents: d.suppressEditEvents !== false,
        };

        this.animationManager.startAnimation(flowId, virtualServerId, config, client, {
          getQueryHoldMs: () => this.getQueryHoldMsForPair(serverConfigId, virtualServerId),
        });
      }
    } catch (err: any) {
      console.error(`[BotEngine] Failed to start animations for flow ${flowId}: ${err.message}`);
    }
  }

  private broadcast(type: string, payload: any): void {
    broadcastScoped(this.wss, type, payload, {
      serverConfigId: payload.serverConfigId as number | undefined,
    });
  }
}
