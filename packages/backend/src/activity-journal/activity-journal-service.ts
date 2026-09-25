/**
 * TeamSpeak activity journal (#91 Slice 5).
 * Observational join/leave capture with bounded queues and retention.
 *
 * Capture shares the main EventBridge SSH/Query session. Upstream Query floods
 * (e.g. Files listing) can disconnect that session — journal reports interrupted
 * and recovers with backoff; it does not rate-limit Files itself.
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
  reconnectAttempt: number;
  nextRetryAt: string | null;
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
const KNOWN_BOT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Bound baseline clientlist so a flooded Query queue cannot strand status at Connecting. */
export const BASELINE_TIMEOUT_MS = 8_000;
const RECOVERY_BASE_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 30_000;

function pairKey(configId: number, sid: number): string {
  return `${configId}:${sid}`;
}

/** Server join: came from nowhere (cfid=0). View-only enters have cfid>0. */
export function isServerJoinEvent(data: Record<string, string>): boolean {
  const cfid = data.cfid ?? data.cfId;
  if (cfid === undefined || cfid === '') return true;
  return Number(cfid) === 0;
}

/** Server leave: going nowhere (ctid=0). Channel view leaves have ctid>0. */
export function isServerLeaveEvent(data: Record<string, string>): boolean {
  const ctid = data.ctid ?? data.ctId;
  if (ctid === undefined || ctid === '') return true;
  return Number(ctid) === 0;
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

/**
 * Accept events while capturing or while reporting a gap.
 * Joins are blocked before baseline (`connecting`); leaves still accepted —
 * they cannot be manufactured by a registration flood.
 */
export function isCaptureAccepting(
  status: ActivityCaptureStatus | undefined,
  eventKind?: ActivityEventKind,
): boolean {
  if (status === 'capturing' || status === 'interrupted' || status === 'persistence_error') {
    return true;
  }
  if (status === 'connecting' && eventKind === 'leave') return true;
  return false;
}

export function recoveryDelayMs(attempt: number): number {
  const capped = Math.min(Math.max(0, attempt), 15);
  return Math.min(RECOVERY_BASE_DELAY_MS * 2 ** capped, RECOVERY_MAX_DELAY_MS);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ActivityJournalService {
  private listening = false;
  private targets = new Map<string, boolean>();
  private status = new Map<string, ActivityCaptureStatus>();
  private queues = new Map<string, PendingRecord[]>();
  private flushing = new Map<string, boolean>();
  private flushAgain = new Map<string, boolean>();
  private dropped = new Map<string, number>();
  private lastError = new Map<string, string | null>();
  private lastPersistedAt = new Map<string, Date | null>();
  /** Clients present at capture start / reconnect — suppress manufactured joins. */
  private baselineClids = new Map<string, Set<string>>();
  private knownBotUids = new Set<string>();
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private knownBotTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryAttempt = new Map<string, number>();
  private nextRetryAt = new Map<string, number>();
  private arming = new Map<string, boolean>();
  /**
   * Bumped on enable/disable/release/stop so in-flight recovery/arm after an
   * await cannot mutate a newer (or disabled) lifecycle for the same key.
   */
  private captureEpoch = new Map<string, number>();
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
    this.knownBotTimer = setInterval(() => {
      void this.refreshKnownBotUids().catch((err) => {
        console.warn(`[ActivityJournal] Known-bot refresh failed: ${err.message}`);
      });
    }, KNOWN_BOT_REFRESH_INTERVAL_MS);
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
    if (this.knownBotTimer) {
      clearInterval(this.knownBotTimer);
      this.knownBotTimer = null;
    }
    for (const key of [...this.recoveryTimers.keys()]) {
      this.invalidateCaptureLifecycle(key);
    }
    for (const key of [...this.targets.keys()]) {
      await this.drainQueue(key);
      const [configId, sid] = key.split(':').map(Number);
      await this.eventBridge.releaseSession('journal', configId, sid);
    }
    this.targets.clear();
    this.status.clear();
    this.baselineClids.clear();
    this.queues.clear();
    this.recoveryAttempt.clear();
    this.nextRetryAt.clear();
    this.arming.clear();
    this.captureEpoch.clear();
  }

  /**
   * Release journal ownership and purge journal rows for a deleted server config.
   */
  async releaseConfig(serverConfigId: number): Promise<void> {
    const prefix = `${serverConfigId}:`;
    for (const key of [...this.targets.keys()]) {
      if (!key.startsWith(prefix)) continue;
      // Invalidate before awaits so in-flight recovery cannot re-arm this key.
      this.invalidateCaptureLifecycle(key);
      this.targets.set(key, false);
      await this.drainQueue(key);
      const sid = parseInt(key.slice(prefix.length), 10);
      if (Number.isFinite(sid)) {
        await this.eventBridge.releaseSession('journal', serverConfigId, sid);
      }
      this.targets.delete(key);
      this.status.delete(key);
      this.baselineClids.delete(key);
      this.queues.delete(key);
      this.dropped.delete(key);
      this.lastError.delete(key);
      this.lastPersistedAt.delete(key);
      this.recoveryAttempt.delete(key);
      this.nextRetryAt.delete(key);
      this.arming.delete(key);
      this.captureEpoch.delete(key);
    }
    await this.prisma.activityJournalTarget.deleteMany({ where: { serverConfigId } });
    await this.prisma.clientActivity.deleteMany({ where: { serverConfigId } });
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
      const epoch = this.beginCaptureLifecycle(key);
      this.targets.set(key, true);
      this.status.set(key, 'connecting');
      this.baselineClids.set(key, new Set());
      this.recoveryAttempt.set(key, 0);
      await this.eventBridge.retainSession('journal', serverConfigId, virtualServerId);
      if (!this.isCaptureEpochCurrent(key, epoch)) return;
      if (this.eventBridge.isRegistered(serverConfigId, virtualServerId)) {
        await this.armCapture(serverConfigId, virtualServerId, epoch);
      } else {
        this.scheduleRecovery(key, epoch);
      }
    } else {
      // Invalidate before awaits so a mid-flight attemptRecovery cannot re-arm.
      this.invalidateCaptureLifecycle(key);
      this.targets.set(key, false);
      this.status.set(key, 'disabled');
      this.baselineClids.delete(key);
      this.recoveryAttempt.delete(key);
      this.nextRetryAt.delete(key);
      await this.drainQueue(key);
      await this.eventBridge.releaseSession('journal', serverConfigId, virtualServerId);
    }
  }

  getStatuses(): ActivityJournalStatus[] {
    const keys = new Set([...this.targets.keys(), ...this.status.keys()]);
    const out: ActivityJournalStatus[] = [];
    for (const key of keys) {
      const [serverConfigId, virtualServerId] = key.split(':').map(Number);
      const enabled = this.targets.get(key) === true;
      const nextAt = this.nextRetryAt.get(key);
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
        reconnectAttempt: enabled ? (this.recoveryAttempt.get(key) ?? 0) : 0,
        nextRetryAt: enabled && nextAt != null ? new Date(nextAt).toISOString() : null,
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
      const epoch = this.beginCaptureLifecycle(key);
      this.targets.set(key, true);
      this.status.set(key, 'connecting');
      this.recoveryAttempt.set(key, 0);
      try {
        await this.eventBridge.retainSession('journal', row.serverConfigId, row.virtualServerId);
        if (!this.isCaptureEpochCurrent(key, epoch)) continue;
        if (this.eventBridge.isRegistered(row.serverConfigId, row.virtualServerId)) {
          await this.armCapture(row.serverConfigId, row.virtualServerId, epoch);
        } else {
          this.scheduleRecovery(key, epoch);
        }
      } catch (err: any) {
        if (!this.isCaptureEpochCurrent(key, epoch)) continue;
        this.status.set(key, 'interrupted');
        this.lastError.set(key, err.message);
        this.scheduleRecovery(key, epoch);
      }
    }
  }

  private async onSshConnected(configId: number, sid: number): Promise<void> {
    const key = pairKey(configId, sid);
    if (this.targets.get(key) !== true) return;
    await this.armCapture(configId, sid, this.captureEpoch.get(key) ?? 0);
  }

  private onSshDisconnected(configId: number, sid: number): void {
    const key = pairKey(configId, sid);
    if (this.targets.get(key) !== true) return;
    const epoch = this.captureEpoch.get(key) ?? 0;
    this.status.set(key, 'interrupted');
    this.baselineClids.set(key, new Set());
    this.lastError.set(key, 'Query session disconnected — reconnecting…');
    this.scheduleRecovery(key, epoch);
  }

  /** Start a new enable lifecycle; cancels timers and invalidates in-flight work. */
  private beginCaptureLifecycle(key: string): number {
    this.clearRecovery(key);
    const next = (this.captureEpoch.get(key) ?? 0) + 1;
    this.captureEpoch.set(key, next);
    return next;
  }

  /** Disable/stop/release: cancel timers and invalidate in-flight recovery/arm. */
  private invalidateCaptureLifecycle(key: string): void {
    this.clearRecovery(key);
    this.captureEpoch.set(key, (this.captureEpoch.get(key) ?? 0) + 1);
  }

  private isCaptureEpochCurrent(key: string, epoch: number): boolean {
    return this.targets.get(key) === true && (this.captureEpoch.get(key) ?? 0) === epoch;
  }

  private clearRecovery(key: string): void {
    const timer = this.recoveryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.recoveryTimers.delete(key);
    this.nextRetryAt.delete(key);
  }

  private scheduleRecovery(key: string, epoch: number): void {
    if (!this.isCaptureEpochCurrent(key, epoch)) return;
    if (this.recoveryTimers.has(key)) return;
    const attempt = this.recoveryAttempt.get(key) ?? 0;
    const delay = recoveryDelayMs(attempt);
    const runAt = Date.now() + delay;
    this.nextRetryAt.set(key, runAt);
    this.recoveryTimers.set(
      key,
      setTimeout(() => {
        this.recoveryTimers.delete(key);
        this.nextRetryAt.delete(key);
        void this.attemptRecovery(key, epoch);
      }, delay),
    );
  }

  private async attemptRecovery(key: string, epoch: number): Promise<void> {
    if (!this.isCaptureEpochCurrent(key, epoch)) return;
    const current = this.status.get(key);
    if (current === 'capturing' || current === 'disabled') return;

    const [configId, sid] = key.split(':').map(Number);
    const attempt = (this.recoveryAttempt.get(key) ?? 0) + 1;
    this.recoveryAttempt.set(key, attempt);

    // Stay honest: first enable uses connecting; post-drop recovery stays interrupted.
    if (current !== 'connecting') {
      this.status.set(key, 'interrupted');
    }
    this.lastError.set(key, `Reconnecting capture (attempt ${attempt})…`);

    try {
      // Nudge shared EventBridge ownership/connect (idempotent when already owned).
      await this.eventBridge.retainSession('journal', configId, sid);
      if (!this.isCaptureEpochCurrent(key, epoch)) return;
      if (this.eventBridge.isRegistered(configId, sid)) {
        await this.armCapture(configId, sid, epoch);
        return;
      }
      this.scheduleRecovery(key, epoch);
    } catch (err: any) {
      if (!this.isCaptureEpochCurrent(key, epoch)) return;
      this.status.set(key, 'interrupted');
      this.lastError.set(key, err.message || 'Capture recovery failed');
      this.scheduleRecovery(key, epoch);
    }
  }

  /**
   * Baseline visible clients then accept joins. Bounded so Query floods cannot
   * leave status stuck on Connecting forever.
   */
  private async armCapture(configId: number, sid: number, epoch: number): Promise<void> {
    const key = pairKey(configId, sid);
    if (!this.isCaptureEpochCurrent(key, epoch)) return;
    if (this.arming.get(key)) return;
    this.arming.set(key, true);
    try {
      if (!this.eventBridge.isRegistered(configId, sid)) {
        if (!this.isCaptureEpochCurrent(key, epoch)) return;
        if (this.status.get(key) !== 'connecting') {
          this.status.set(key, 'interrupted');
        }
        this.scheduleRecovery(key, epoch);
        return;
      }

      // Keep accepting leaves while baseline runs; joins stay blocked until ready.
      if (this.status.get(key) !== 'capturing') {
        this.status.set(key, 'connecting');
      }

      const baseline = new Set<string>();
      try {
        const raw = await withTimeout(
          this.eventBridge.executeCommand(configId, sid, 'clientlist -uid'),
          BASELINE_TIMEOUT_MS,
          'Activity journal baseline clientlist',
        );
        if (!this.isCaptureEpochCurrent(key, epoch)) return;
        const { parseQueryResponse } = await import('@ts6/common');
        const rows = parseQueryResponse(raw.trim()) as Record<string, string>[];
        for (const row of rows) {
          if (row.clid) baseline.add(row.clid);
        }
        this.lastError.set(key, null);
      } catch (err: any) {
        if (!this.isCaptureEpochCurrent(key, epoch)) return;
        console.warn(`[ActivityJournal] Baseline clientlist failed for ${key}: ${err.message}`);
        this.lastError.set(
          key,
          `Baseline incomplete (${err.message}); capturing without join suppression`,
        );
      }

      if (!this.isCaptureEpochCurrent(key, epoch)) return;
      if (!this.eventBridge.isRegistered(configId, sid)) {
        this.status.set(key, 'interrupted');
        this.baselineClids.set(key, new Set());
        this.scheduleRecovery(key, epoch);
        return;
      }

      this.baselineClids.set(key, baseline);
      this.status.set(key, 'capturing');
      this.recoveryAttempt.set(key, 0);
      this.clearRecovery(key);
    } finally {
      this.arming.set(key, false);
    }
  }

  private onTsEvent(
    configId: number,
    sid: number,
    eventName: string,
    data: Record<string, string>,
  ): void {
    const key = pairKey(configId, sid);
    if (this.targets.get(key) !== true) return;
    // Ignore command-listener duplicates — main EventBridge stream only.
    if (data.__cmd_listener_channel_id) return;

    if (eventName === 'notifycliententerview') {
      if (!isCaptureAccepting(this.status.get(key), 'join')) return;
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
      if (!isCaptureAccepting(this.status.get(key), 'leave')) return;
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

    // Leave payloads from TS rarely include identity; presence after EventBridge enrich ⇒ cache.
    // Joins carry identity on the native event ⇒ event.
    const before: Record<string, string> =
      eventKind === 'leave'
        ? { clid: data.clid || '' }
        : Object.fromEntries(
            CLIENT_IDENTITY_FIELDS.filter((f) => data[f]).map((f) => [f, data[f]!]),
          );
    const identityProvenance =
      eventKind === 'leave'
        ? resolveIdentityProvenance(before, data)
        : resolveIdentityProvenance(data, data);

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
      // Visible gap — keep accepting events (do not freeze on `interrupted`).
      if (this.status.get(key) === 'capturing') {
        this.status.set(key, 'interrupted');
      }
      return;
    }
    queue.push(record);
    void this.flush(key);
  }

  private async flush(key: string): Promise<void> {
    if (this.flushing.get(key)) {
      // Enqueue raced with an in-flight flush — run again after it finishes.
      this.flushAgain.set(key, true);
      return;
    }
    this.flushing.set(key, true);
    try {
      do {
        this.flushAgain.set(key, false);
        const queue = this.queues.get(key);
        while (queue && queue.length > 0) {
          const batch = queue.splice(0, 50);
          try {
            await this.prisma.clientActivity.createMany({ data: batch });
            this.lastPersistedAt.set(key, new Date());
            this.lastError.set(key, null);
            this.maybeRestoreCapturing(key);
          } catch (err: any) {
            this.lastError.set(key, err.message);
            this.status.set(key, 'persistence_error');
            this.dropped.set(key, (this.dropped.get(key) ?? 0) + batch.length);
            // Surface the gap; continue accepting. Remaining queued items retry on next flush.
            break;
          }
        }
      } while (this.flushAgain.get(key));
    } finally {
      this.flushing.set(key, false);
      // Final race: item arrived after last flushAgain clear but before unlocking.
      if ((this.queues.get(key)?.length ?? 0) > 0) {
        void this.flush(key);
      }
    }
  }

  private maybeRestoreCapturing(key: string): void {
    if (this.targets.get(key) !== true) return;
    const current = this.status.get(key);
    if (current !== 'interrupted' && current !== 'persistence_error') return;
    // Do not clear SSH-disconnect interrupted while still offline.
    const [configId, sid] = key.split(':').map(Number);
    if (!this.eventBridge.isRegistered(configId, sid)) return;
    // Keep interrupted while the queue is still overflowing / non-empty after overflow
    // only when we just successfully wrote — restore once writes succeed again.
    this.status.set(key, 'capturing');
    this.recoveryAttempt.set(key, 0);
    this.clearRecovery(key);
  }

  private async drainQueue(key: string): Promise<void> {
    // Wait briefly for an in-flight flush, then force one more pass.
    for (let i = 0; i < 50 && this.flushing.get(key); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await this.flush(key);
    for (let i = 0; i < 50 && this.flushing.get(key); i++) {
      await new Promise((r) => setTimeout(r, 20));
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
