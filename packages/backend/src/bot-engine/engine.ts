import cron from 'node-cron';
import type { WebSocketServer } from 'ws';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import type {
  BotFlowData,
  BotNode,
  TriggerNodeData,
  CronTriggerData,
  WebhookTriggerData,
  EventTriggerData,
  CommandTriggerData,
  AnimatedChannelActionData,
} from '@ts6/common';
import { FlowRunner } from './flow-runner.js';
import { EventBridge } from './event-bridge.js';
import { AnimationManager, type AnimationConfig } from './animation-manager.js';
import { VoiceBotManager } from '../voice/voice-bot-manager.js';
import { parseMusicCommandChannelIds } from '../voice/music-command-channels.js';
import { MusicCommandHandler } from '../voice/music-command-handler.js';
import { broadcastScoped } from '../ws/ws-session.js';
import { parseStoredCommandNames } from './command-whitelist.js';

interface RuntimeFlow {
  id: number;
  name: string;
  serverConfigId: number;
  virtualServerId: number;
  flowData: BotFlowData;
  triggerNodes: BotNode[];
}

interface WebhookEntry {
  flowId: number;
  nodeId: string;
  path: string;
  method: string;
  secret?: string;
}

export class BotEngine {
  private flows: Map<number, RuntimeFlow> = new Map();
  private eventBridge: EventBridge;
  private flowRunner: FlowRunner;
  private animationManager: AnimationManager;
  private cronJobs: Array<{ flowId: number; nodeId: string; task: cron.ScheduledTask }> = [];
  private webhookEntries: WebhookEntry[] = [];
  private executionCounts: Map<number, number> = new Map();
  private voiceBotManager: VoiceBotManager | null = null;
  private musicCommandHandler: MusicCommandHandler | null = null;
  private activeMusicCommandListeners = new Set<string>();
  private stopped = false;

  constructor(
    private prisma: PrismaClient,
    private connectionPool: ConnectionPool,
    private wss: WebSocketServer,
  ) {
    this.eventBridge = new EventBridge(prisma);
    this.flowRunner = new FlowRunner(prisma, connectionPool, wss, this.eventBridge);
    this.animationManager = new AnimationManager();
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.loadFlows();

    this.eventBridge.on('tsEvent', (configId, sid, eventName, data) => {
      this.onTsEvent(configId, sid, eventName, data);
    });

    this.setupSshConnections();
    this.setupCronJobs();
    this.buildWebhookRegistry();
    this.setupAnimations();

    // Music bots run independently of bot flows but share persisted server configs.
    this.voiceBotManager = new VoiceBotManager(this.prisma, this.eventBridge);
    await this.voiceBotManager.loadBots();
    await this.syncAllMusicCommandListeners();

    this.musicCommandHandler = new MusicCommandHandler(
      this.prisma,
      this.voiceBotManager,
      this.eventBridge,
    );
    this.musicCommandHandler.register();

    console.log(`[BotEngine] Started with ${this.flows.size} flow(s), ${this.eventBridge.getConnectedKeys().length} SSH connection(s), ${this.cronJobs.length} cron job(s), ${this.webhookEntries.length} webhook(s)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.teardownCronJobs();
    this.animationManager.stopAll();
    this.musicCommandHandler?.destroy();
    this.musicCommandHandler = null;
    this.voiceBotManager?.stopAll();
    this.voiceBotManager = null;
    this.activeMusicCommandListeners.clear();
    await this.eventBridge.destroy();
    this.flows.clear();
    this.webhookEntries = [];
    this.executionCounts.clear();
  }

  getEventBridge(): EventBridge {
    return this.eventBridge;
  }

  getVoiceBotManager(): VoiceBotManager | null {
    return this.voiceBotManager;
  }

  private async loadFlows(): Promise<void> {
    const dbFlows = await this.prisma.botFlow.findMany({ where: { enabled: true } });

    for (const flow of dbFlows) {
      try {
        const flowData: BotFlowData = JSON.parse(flow.flowData);
        const triggerNodes = flowData.nodes.filter(n => n.type === 'trigger');
        this.flows.set(flow.id, {
          id: flow.id,
          name: flow.name,
          serverConfigId: flow.serverConfigId,
          virtualServerId: flow.virtualServerId,
          flowData,
          triggerNodes,
        });
      } catch (err: any) {
        console.error(`[BotEngine] Failed to load flow ${flow.id}: ${err.message}`);
      }
    }
  }

  async reloadFlow(flowId: number): Promise<void> {
    this.teardownCronJobs(flowId);
    this.animationManager.stopAnimation(flowId);
    this.webhookEntries = this.webhookEntries.filter(e => e.flowId !== flowId);
    this.flows.delete(flowId);

    const flow = await this.prisma.botFlow.findUnique({ where: { id: flowId } });
    if (!flow?.enabled) {
      await this.cleanupUnusedSshConnections();
      return;
    }

    try {
      const flowData: BotFlowData = JSON.parse(flow.flowData);
      const triggerNodes = flowData.nodes.filter(n => n.type === 'trigger');
      this.flows.set(flow.id, {
        id: flow.id,
        name: flow.name,
        serverConfigId: flow.serverConfigId,
        virtualServerId: flow.virtualServerId,
        flowData,
        triggerNodes,
      });

      const pair = `${flow.serverConfigId}:${flow.virtualServerId}`;
      if (this.getNeededServerPairs().has(pair) && !this.eventBridge.isConnected(flow.serverConfigId, flow.virtualServerId)) {
        this.eventBridge.connectServer(flow.serverConfigId, flow.virtualServerId).catch(err => {
          console.error(`[BotEngine] SSH connection failed for ${pair}: ${err.message}`);
        });
      }
      this.syncCommandListenersForPair(flow.serverConfigId, flow.virtualServerId);
      this.setupCronJobsForFlow(flow.id);
      this.buildWebhookRegistryForFlow(flow.id);
      this.startAnimationsForFlow(flow.id, flow.serverConfigId, flow.virtualServerId);
    } catch (err: any) {
      console.error(`[BotEngine] Failed to reload flow ${flowId}: ${err.message}`);
    }
  }

  async handleWebhook(
    path: string,
    method: string,
    headers: Record<string, string | string[] | undefined>,
    body: any,
    query: Record<string, any>,
  ): Promise<{ matched: boolean; accepted: boolean }> {
    const entry = this.webhookEntries.find(
      e => e.path === path && e.method.toUpperCase() === method.toUpperCase()
    );
    if (!entry) return { matched: false, accepted: false };

    if (entry.secret) {
      const supplied = headers['x-webhook-secret'];
      const suppliedValue = Array.isArray(supplied) ? supplied[0] : supplied;
      if (suppliedValue !== entry.secret) return { matched: true, accepted: false };
    }

    const flow = this.flows.get(entry.flowId);
    if (!flow) return { matched: true, accepted: false };

    this.executeFlow(flow, entry.nodeId, 'webhook', {
      body,
      query,
      headers,
    });

    return { matched: true, accepted: true };
  }

  async triggerFlowManually(flowId: number, data: Record<string, any> = {}): Promise<void> {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`Flow ${flowId} is not enabled or not loaded`);

    const manualTrigger = flow.triggerNodes.find(n => (n.data as TriggerNodeData).triggerType === 'manual');
    if (!manualTrigger) throw new Error(`Flow ${flowId} has no manual trigger`);

    this.executeFlow(flow, manualTrigger.id, 'manual', data);
  }

  private setupAnimations(): void {
    for (const flow of this.flows.values()) {
      this.startAnimationsForFlow(flow.id, flow.serverConfigId, flow.virtualServerId);
    }
  }

  private musicListenerKey(configId: number, sid: number, channelId: number): string {
    return `${configId}:${sid}:cmd:${channelId}`;
  }

  private syncCommandListenersForPair(configId: number, sid: number): void {
    void this.syncCommandListenersForPairAsync(configId, sid).catch((err: any) => {
      console.error(`[BotEngine] Failed to sync command listeners for ${configId}:${sid}: ${err.message}`);
    });
  }

  private async syncCommandListenersForPairAsync(configId: number, sid: number): Promise<void> {
    if (!this.voiceBotManager) return;

    const bots = await this.prisma.musicBot.findMany({
      where: {
        serverConfigId: configId,
        virtualServerId: sid,
      },
      select: {
        id: true,
        commandChannelIds: true,
      },
    });

    const wanted = new Set<string>();
    for (const bot of bots) {
      for (const channelId of parseMusicCommandChannelIds(bot.commandChannelIds)) {
        wanted.add(this.musicListenerKey(configId, sid, channelId));
      }
    }

    for (const key of [...this.activeMusicCommandListeners]) {
      if (!key.startsWith(`${configId}:${sid}:cmd:`) || wanted.has(key)) continue;
      const channelId = Number(key.split(':').pop());
      await this.eventBridge.disconnectCommandListener(configId, sid, channelId);
      this.activeMusicCommandListeners.delete(key);
    }

    for (const key of wanted) {
      if (this.activeMusicCommandListeners.has(key)) continue;
      const channelId = Number(key.split(':').pop());
      await this.eventBridge.connectCommandListener(configId, sid, channelId);
      this.activeMusicCommandListeners.add(key);
    }
  }

  private async syncAllMusicCommandListeners(): Promise<void> {
    const pairs = new Set<string>();

    const bots = await this.prisma.musicBot.findMany({
      select: { serverConfigId: true, virtualServerId: true, commandChannelIds: true },
    });
    for (const bot of bots) {
      if (parseMusicCommandChannelIds(bot.commandChannelIds).length > 0) {
        pairs.add(`${bot.serverConfigId}:${bot.virtualServerId}`);
      }
    }

    for (const pair of pairs) {
      const [configId, sid] = pair.split(':').map(Number);
      await this.syncCommandListenersForPairAsync(configId, sid);
    }
  }

  private getNeededServerPairs(): Set<string> {
    const pairs = new Set<string>();
    for (const flow of this.flows.values()) {
      let needsSsh = false;
      for (const node of flow.flowData.nodes) {
        const d: any = node.data;
        if (node.type === 'trigger' && (d.triggerType === 'event' || d.triggerType === 'command')) {
          needsSsh = true;
          break;
        }
        if (node.type === 'action' && d.actionType === 'sshCommand') {
          needsSsh = true;
          break;
        }
      }
      if (needsSsh) {
        pairs.add(`${flow.serverConfigId}:${flow.virtualServerId}`);
      }
    }
    return pairs;
  }

  private setupSshConnections(): void {
    const serverPairs = this.getNeededServerPairs();

    for (const pair of serverPairs) {
      const [configId, sid] = pair.split(':').map(Number);
      // Non-blocking: don't await SSH connections during startup
      this.eventBridge.connectServer(configId, sid).catch(err => {
        console.error(`[BotEngine] SSH connection failed for ${pair}: ${err.message}`);
      });
      this.syncCommandListenersForPair(configId, sid);
    }
  }

  private async cleanupUnusedSshConnections(): Promise<void> {
    const neededPairs = this.getNeededServerPairs();

    // 1) cleanup unused ssh connections
    for (const key of this.eventBridge.getConnectedKeys()) {
      if (!neededPairs.has(key)) {
        const [configId, sid] = key.split(':').map(Number);
        await this.eventBridge.disconnectServer(configId, sid);
      }
    }

    // 2) sync command listeners per pair
    for (const pair of neededPairs) {
      const [configId, sid] = pair.split(':').map(Number);
      this.syncCommandListenersForPair(configId, sid);
    }

    // 3) delete command listener for unused pairs
    for (const cmdKey of this.eventBridge.getCommandListenerKeys()) {
      // expected: `${configId}:${sid}:cmd:${channelId}`
      const m = cmdKey.match(/^(\d+):(\d+):cmd:(\d+)$/);
      if (!m) continue;

      const configId = Number(m[1]);
      const sid = Number(m[2]);
      const channelId = Number(m[3]);

      const pairKey = `${configId}:${sid}`;
      if (!neededPairs.has(pairKey)) {
        await this.eventBridge.disconnectCommandListener(configId, sid, channelId);
      }
    }
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

          this.executeFlow(flow, triggerNode.id, 'command', enrichedData);
        }
      }
    }
  }

  private executeFlow(
    flow: RuntimeFlow,
    triggerNodeId: string,
    triggerType: string,
    eventData: Record<string, any>,
  ): void {
    const count = this.executionCounts.get(flow.id) || 0;
    if (count >= 5) {
      console.warn(`[BotEngine] Flow ${flow.id} concurrency limit reached`);
      return;
    }
    this.executionCounts.set(flow.id, count + 1);

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

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

  private startAnimationsForFlow(flowId: number, serverConfigId: number, virtualServerId: number): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;

    const animNodes = flow.flowData.nodes.filter(
      n => n.type === 'action' && (n.data as any).actionType === 'animatedChannel'
    );

    if (animNodes.length === 0) return;

    try {
      const getClient = () => this.connectionPool.getClient(serverConfigId);
      // Verify a client exists now; each animation tick resolves it again so a
      // later connection refresh automatically switches to the replacement.
      getClient();

      for (const node of animNodes) {
        const d = node.data as AnimatedChannelActionData;
        const parsedInterval = parseFloat(String(d.intervalSeconds));
        const config: AnimationConfig = {
          channelId: d.channelId,
          text: d.text,
          style: d.style || 'scroll',
          intervalSeconds: Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 3,
          prefix: d.prefix || '[cspacer]',
          suppressEditEvents: d.suppressEditEvents !== false,
        };

        this.animationManager.startAnimation(flowId, virtualServerId, config, getClient);
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
