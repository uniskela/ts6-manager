/**
 * TeamSpeak activity journal (#91 Slice 5).
 * Observational join/leave capture with bounded queues and retention.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import type { EventBridge } from '../bot-engine/event-bridge.js';
import { decrypt } from '../utils/crypto.js';
import { CLIENT_IDENTITY_FIELDS } from '../bot-engine/client-metadata-cache.js';

export type ActivityEventKind = 'join' | 'leave';
export type ActivityClassification = 'known_bot' | 'query' | 'voice' | 'unknown';
export type ActivityIdentityProvenance = 'event' | 'cache' | 'mixed' | 'none';
export type ActivityCaptureStatus =
  | 'disabled'
  | 'connecting'
  | 'capturing'
  | 'interrupted'
  | 'persistence_error';

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

interface PendingRecord {
  observedAt: Date;
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

const QUEUE_CAPACITY = 500;
const RETENTION_DAYS = 7;
const RETENTION_PER_PAIR = 10_000;
const RETENTION_GLOBAL = 100_000;
const NICK_MAX = 30;
const UID_MAX = 64;
const RETENTION_INTERVAL_MS = 5 * 60 * 1000;

function pairKey(configId: number, sid: number): string {
  return `${configId}:${sid}`;
}

/** Server join: came from nowhere (cfid=0). View-only enters have cfid>0. */
export function isServerJoinEvent(data: Record<string, string>): boolean {
  const cfid = data.cfid ?? data.cfId;
  return cfid === undefined || cfid === '' || cfid === '0';
}

/** Server leave: going nowhere (ctid=0). Channel view leaves have ctid>0. */
export function isServerLeaveEvent(data: Record<string, string>): boolean {
  const ctid = data.ctid ?? data.ctId;
  return ctid === undefined || ctid === '' || ctid === '0';
}

export function classifyClient(opts: {
  clientType: number | null;
  uniqueId: string | null;
  knownBotUids: Set<string>;
}): ActivityClassification {
  if (opts.clientType === 1) return 'query';
  if (opts.uniqueId && opts.knownBotUids.has(opts.uniqueId)) return 'known_bot';
  if (opts.clientType === 0) return 'voice';
  return 'unknown';
}

/** Compare pre/post enrich payloads to label identity provenance. */
export function resolveIdentityProvenance(
  before: Record<string, string>,
  after: Record<string, string>,
): ActivityIdentityProvenance {
  const beforeCount = CLIENT_IDENTITY_FIELDS.filter((f) => before[f]).length;
  const afterCount = CLIENT_IDENTITY_FIELDS.filter((f) => after[f]).length;
  if (afterCount === 0) return 'none';
  if (beforeCount === afterCount) return 'event';
  if (beforeCount === 0 && afterCount > 0) return 'cache';
  if (beforeCount > 0 && afterCount > beforeCount) return 'mixed';
  return 'event';
}

export class ActivityJournalService {
  private listening = false;
  private targets = new Map<string, boolean>();
  private status = new Map<string, ActivityCaptureStatus>();
  private queues = new Map<string, PendingRecord[]>();
  private flushing = new Map<string, boolean>();
  private dropped = new Map<string, number>();
  private lastError = new Map<string, string | null>();
  private lastPersistedAt = new Map<string, Date | null>();
  /** Clients present at capture start / reconnect — suppress manufactured joins. */
  private baselineClids = new Map<string, Set<string>>();
  private knownBotUids = new Set<string>();
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onTsEventBound = (
    configId: number,
    sid: number,
    eventName: string,
    data: Record<string, string>,
  ) => this.onTsEvent(configId, sid, eventName, data);
  private readonly onSshConnectedBound = (configId: number, sid: number) => {
    void this.onSshConnected(configId, sid);
  };
  private readonly onSshDisconnectedBound = (configId: number, sid: number) => {
    this.onSshDisconnected(configId, sid);
  };

  constructor(
    private prisma: PrismaClient,
    private eventBridge: EventBridge,
  ) {}

  async start(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.eventBridge.on('tsEvent', this.onTsEventBound);
    this.eventBridge.on('sshConnected', this.onSshConnectedBound);
    this.eventBridge.on('sshDisconnected', this.onSshDisconnectedBound);
    await this.refreshKnownBotUids();
    await this.loadTargetsAndCapture();
    this.retentionTimer = setInterval(() => {
      void this.runRetention().catch((err) => {
        console.warn(`[ActivityJournal] Retention failed: ${err.message}`);
      });
    }, RETENTION_INTERVAL_MS);
    console.log('[ActivityJournal] Started');
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    this.eventBridge.off('tsEvent', this.onTsEventBound);
    this.eventBridge.off('sshConnected', this.onSshConnectedBound);
    this.eventBridge.off('sshDisconnected', this.onSshDisconnectedBound);
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    for (const key of [...this.targets.keys()]) {
      const [configId, sid] = key.split(':').map(Number);
      await this.eventBridge.releaseSession('journal', configId, sid);
    }
    this.targets.clear();
    this.status.clear();
    this.baselineClids.clear();
  }

  async refreshKnownBotUids(): Promise<void> {
    const bots = await this.prisma.musicBot.findMany({
      select: { identityData: true },
    });
    const uids = new Set<string>();
    for (const bot of bots) {
      if (!bot.identityData) continue;
      try {
        const parsed = JSON.parse(decrypt(bot.identityData));
        const uid = typeof parsed?.uid === 'string' ? parsed.uid : null;
        if (uid) uids.add(uid);
      } catch {
        // Ignore malformed / undecryptable identities.
      }
    }
    this.knownBotUids = uids;
  }

  async listTargets(): Promise<Array<{ serverConfigId: number; virtualServerId: number; enabled: boolean }>> {
    const rows = await this.prisma.activityJournalTarget.findMany({
      orderBy: [{ serverConfigId: 'asc' }, { virtualServerId: 'asc' }],
    });
    return rows.map((r) => ({
      serverConfigId: r.serverConfigId,
      virtualServerId: r.virtualServerId,
      enabled: r.enabled,
    }));
  }

  async setTarget(serverConfigId: number, virtualServerId: number, enabled: boolean): Promise<void> {
    await this.prisma.activityJournalTarget.upsert({
      where: {
        serverConfigId_virtualServerId: { serverConfigId, virtualServerId },
      },
      create: { serverConfigId, virtualServerId, enabled },
      update: { enabled },
    });
    const key = pairKey(serverConfigId, virtualServerId);
    if (enabled) {
      this.targets.set(key, true);
      this.status.set(key, 'connecting');
      this.baselineClids.set(key, new Set());
      await this.eventBridge.retainSession('journal', serverConfigId, virtualServerId);
      if (this.eventBridge.isRegistered(serverConfigId, virtualServerId)) {
        await this.onSshConnected(serverConfigId, virtualServerId);
      }
    } else {
      this.targets.set(key, false);
      this.status.set(key, 'disabled');
      this.baselineClids.delete(key);
      await this.eventBridge.releaseSession('journal', serverConfigId, virtualServerId);
      // Keep target row; status disabled.
    }
  }

  getStatuses(): ActivityJournalStatus[] {
    const keys = new Set([...this.targets.keys(), ...this.status.keys()]);
    const out: ActivityJournalStatus[] = [];
    for (const key of keys) {
      const [serverConfigId, virtualServerId] = key.split(':').map(Number);
      const enabled = this.targets.get(key) === true;
      out.push({
        serverConfigId,
        virtualServerId,
        enabled,
        status: enabled ? (this.status.get(key) || 'connecting') : 'disabled',
        queueDepth: this.queues.get(key)?.length ?? 0,
        queueCapacity: QUEUE_CAPACITY,
        droppedEvents: this.dropped.get(key) ?? 0,
        lastError: this.lastError.get(key) ?? null,
        lastPersistedAt: this.lastPersistedAt.get(key)?.toISOString() ?? null,
        sshConnected: this.eventBridge.isConnected(serverConfigId, virtualServerId),
        sshRegistered: this.eventBridge.isRegistered(serverConfigId, virtualServerId),
        connectionGeneration: this.eventBridge.getClientCacheGeneration(serverConfigId, virtualServerId),
      });
    }
    return out.sort(
      (a, b) =>
        a.serverConfigId - b.serverConfigId || a.virtualServerId - b.virtualServerId,
    );
  }

  async listHistory(opts: {
    serverConfigId?: number;
    virtualServerId?: number;
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: Array<Record<string, unknown>>;
    nextCursor: string | null;
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: Record<string, unknown> = {};
    if (opts.serverConfigId != null) where.serverConfigId = opts.serverConfigId;
    if (opts.virtualServerId != null) where.virtualServerId = opts.virtualServerId;

    // Cursor = `${observedAt.toISOString()}|${id}` for stable pagination.
    if (opts.cursor) {
      const [iso, id] = opts.cursor.split('|');
      const observedAt = new Date(iso);
      if (!Number.isNaN(observedAt.getTime()) && id) {
        where.OR = [
          { observedAt: { lt: observedAt } },
          { observedAt, id: { lt: id } },
        ];
      }
    }

    const rows = await this.prisma.clientActivity.findMany({
      where,
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const next =
      rows.length > limit
        ? `${slice[slice.length - 1].observedAt.toISOString()}|${slice[slice.length - 1].id}`
        : null;

    return {
      items: slice.map((r) => ({
        id: r.id,
        observedAt: r.observedAt.toISOString(),
        serverConfigId: r.serverConfigId,
        virtualServerId: r.virtualServerId,
        connectionGeneration: r.connectionGeneration,
        eventKind: r.eventKind,
        clientId: r.clientId,
        nickname: r.nickname,
        uniqueId: r.uniqueId,
        databaseId: r.databaseId,
        clientType: r.clientType,
        classification: r.classification,
        identityProvenance: r.identityProvenance,
      })),
      nextCursor: next,
    };
  }

  private async loadTargetsAndCapture(): Promise<void> {
    const rows = await this.prisma.activityJournalTarget.findMany({ where: { enabled: true } });
    for (const row of rows) {
      const key = pairKey(row.serverConfigId, row.virtualServerId);
      this.targets.set(key, true);
      this.status.set(key, 'connecting');
      try {
        await this.eventBridge.retainSession('journal', row.serverConfigId, row.virtualServerId);
        if (this.eventBridge.isRegistered(row.serverConfigId, row.virtualServerId)) {
          await this.onSshConnected(row.serverConfigId, row.virtualServerId);
        }
      } catch (err: any) {
        this.status.set(key, 'interrupted');
        this.lastError.set(key, err.message);
      }
    }
  }

  private async onSshConnected(configId: number, sid: number): Promise<void> {
    const key = pairKey(configId, sid);
    if (this.targets.get(key) !== true) return;

    // Baseline currently-visible clients so registration floods are not journaled as joins.
    const baseline = new Set<string>();
    try {
      const raw = await this.eventBridge.executeCommand(configId, sid, 'clientlist -uid');
      const { parseQueryResponse } = await import('@ts6/common');
      const rows = parseQueryResponse(raw.trim()) as Record<string, string>[];
      for (const row of rows) {
        if (row.clid) baseline.add(row.clid);
      }
    } catch (err: any) {
      console.warn(`[ActivityJournal] Baseline clientlist failed for ${key}: ${err.message}`);
    }
    this.baselineClids.set(key, baseline);
    this.status.set(key, 'capturing');
    this.lastError.set(key, null);
  }

  private onSshDisconnected(configId: number, sid: number): void {
    const key = pairKey(configId, sid);
    if (this.targets.get(key) !== true) return;
    this.status.set(key, 'interrupted');
    this.baselineClids.set(key, new Set());
  }

  private onTsEvent(
    configId: number,
    sid: number,
    eventName: string,
    data: Record<string, string>,
  ): void {
    const key = pairKey(configId, sid);
    if (this.targets.get(key) !== true) return;
    // Wait until baseline snapshot completes — avoids journaling registration floods as joins.
    if (this.status.get(key) !== 'capturing') return;
    // Ignore command-listener duplicates — main EventBridge stream only.
    if (data.__cmd_listener_channel_id) return;

    if (eventName === 'notifycliententerview') {
      if (!isServerJoinEvent(data)) return;
      const clid = data.clid;
      if (!clid) return;
      const baseline = this.baselineClids.get(key);
      if (baseline?.has(clid)) {
        baseline.delete(clid);
        return;
      }
      this.enqueue(key, this.buildRecord(configId, sid, 'join', data));
      return;
    }

    if (eventName === 'notifyclientleftview') {
      if (!isServerLeaveEvent(data)) return;
      const clid = data.clid;
      if (!clid) return;
      // Never drop incomplete leave events — persist with whatever identity is present.
      this.enqueue(key, this.buildRecord(configId, sid, 'leave', data));
      return;
    }
  }

  private buildRecord(
    configId: number,
    sid: number,
    eventKind: ActivityEventKind,
    data: Record<string, string>,
  ): PendingRecord {
    const clientId = parseInt(data.clid || '0', 10) || 0;
    const clientTypeRaw = data.client_type;
    const clientType =
      clientTypeRaw !== undefined && clientTypeRaw !== ''
        ? parseInt(clientTypeRaw, 10)
        : null;
    const uniqueId = data.client_unique_identifier
      ? data.client_unique_identifier.slice(0, UID_MAX)
      : null;
    const nickname = data.client_nickname
      ? data.client_nickname.slice(0, NICK_MAX)
      : null;
    const databaseIdRaw = data.client_database_id;
    const databaseId =
      databaseIdRaw !== undefined && databaseIdRaw !== ''
        ? parseInt(databaseIdRaw, 10)
        : null;

    const classification = classifyClient({
      clientType: Number.isFinite(clientType as number) ? (clientType as number) : null,
      uniqueId,
      knownBotUids: this.knownBotUids,
    });

    const hasIdentity = CLIENT_IDENTITY_FIELDS.some((f) => Boolean(data[f]));
    let identityProvenance: ActivityIdentityProvenance = 'none';
    if (hasIdentity) {
      // Native leave payloads usually omit identity; presence after EventBridge enrich ⇒ cache.
      identityProvenance = eventKind === 'leave' ? 'cache' : 'event';
    }

    return {
      observedAt: new Date(),
      serverConfigId: configId,
      virtualServerId: sid,
      connectionGeneration: this.eventBridge.getClientCacheGeneration(configId, sid),
      eventKind,
      clientId,
      nickname,
      uniqueId,
      databaseId: Number.isFinite(databaseId as number) ? (databaseId as number) : null,
      clientType: Number.isFinite(clientType as number) ? (clientType as number) : null,
      classification,
      identityProvenance,
    };
  }

  private enqueue(key: string, record: PendingRecord): void {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }
    if (queue.length >= QUEUE_CAPACITY) {
      this.dropped.set(key, (this.dropped.get(key) ?? 0) + 1);
      if (this.status.get(key) === 'capturing') this.status.set(key, 'interrupted');
      return;
    }
    queue.push(record);
    void this.flush(key);
  }

  private async flush(key: string): Promise<void> {
    if (this.flushing.get(key)) return;
    this.flushing.set(key, true);
    try {
      const queue = this.queues.get(key);
      while (queue && queue.length > 0) {
        const batch = queue.splice(0, 50);
        try {
          await this.prisma.clientActivity.createMany({ data: batch });
          this.lastPersistedAt.set(key, new Date());
          this.lastError.set(key, null);
          if (this.targets.get(key) === true && this.status.get(key) === 'persistence_error') {
            const [configId, sid] = key.split(':').map(Number);
            this.status.set(
              key,
              this.eventBridge.isRegistered(configId, sid) ? 'capturing' : 'interrupted',
            );
          }
        } catch (err: any) {
          this.lastError.set(key, err.message);
          this.status.set(key, 'persistence_error');
          this.dropped.set(key, (this.dropped.get(key) ?? 0) + batch.length);
          // Do not re-queue forever — surface the gap via droppedEvents.
          break;
        }
      }
    } finally {
      this.flushing.set(key, false);
    }
  }

  async runRetention(): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let deleted = 0;

    const aged = await this.prisma.clientActivity.deleteMany({
      where: { observedAt: { lt: cutoff } },
    });
    deleted += aged.count;

    // Per connection/SID cap.
    const pairs = await this.prisma.clientActivity.groupBy({
      by: ['serverConfigId', 'virtualServerId'],
      _count: { _all: true },
    });
    for (const pair of pairs) {
      const count = pair._count._all;
      if (count <= RETENTION_PER_PAIR) continue;
      const overflow = count - RETENTION_PER_PAIR;
      const old = await this.prisma.clientActivity.findMany({
        where: {
          serverConfigId: pair.serverConfigId,
          virtualServerId: pair.virtualServerId,
        },
        orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
        take: overflow,
        select: { id: true },
      });
      if (old.length === 0) continue;
      const res = await this.prisma.clientActivity.deleteMany({
        where: { id: { in: old.map((r) => r.id) } },
      });
      deleted += res.count;
    }

    // Global cap.
    const total = await this.prisma.clientActivity.count();
    if (total > RETENTION_GLOBAL) {
      const overflow = total - RETENTION_GLOBAL;
      const old = await this.prisma.clientActivity.findMany({
        orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
        take: overflow,
        select: { id: true },
      });
      if (old.length > 0) {
        const res = await this.prisma.clientActivity.deleteMany({
          where: { id: { in: old.map((r) => r.id) } },
        });
        deleted += res.count;
      }
    }

    return { deleted };
  }
}

export const ACTIVITY_JOURNAL_RETENTION = {
  days: RETENTION_DAYS,
  perConnectionSid: RETENTION_PER_PAIR,
  global: RETENTION_GLOBAL,
  queueCapacity: QUEUE_CAPACITY,
} as const;
