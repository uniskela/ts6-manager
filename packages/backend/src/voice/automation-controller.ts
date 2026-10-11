import type { BotAutomationSettings } from '@ts6/common';
import type { QueueItem } from './playlist/queue.js';

export interface AutomationRuntimeState {
  quietUntil: number;
  retryUntil: number;
  failures: number;
  lastTrackId: string | null;
  presenceSuppressed: boolean;
  sourceKey: string | null;
  channelId: number | null;
}

export interface AutomationSnapshot {
  connected: boolean;
  busy: boolean;
  hasRequests: boolean;
  humanListeners: number;
}

export interface AutomationClock {
  now(): number;
  /** Return a function that cancels the timer. */
  setTimer(callback: () => void, delayMs: number): () => void;
}

export interface AutomationControllerOptions {
  settings: BotAutomationSettings;
  state?: Partial<AutomationRuntimeState>;
  snapshot(): AutomationSnapshot;
  loadSource(source: NonNullable<BotAutomationSettings['source']>, lastTrackId: string | null): Promise<QueueItem>;
  /** Check isCurrent after asynchronous preparation and before committing playback. */
  play(item: QueueItem, isCurrent: () => boolean): Promise<void>;
  stop(): void;
  persist(state: AutomationRuntimeState): Promise<void>;
  onError?(error: unknown): void;
  clock?: AutomationClock;
}

const systemClock: AutomationClock = {
  now: Date.now,
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

function key(settings: BotAutomationSettings): string | null {
  return settings.source ? `${settings.source.kind}:${settings.source.id}` : null;
}

/** Owns fallback playback only. The human request queue remains owned by VoiceBot. */
export class AutomationController {
  private settings: BotAutomationSettings;
  private readonly runtime: AutomationRuntimeState;
  private readonly clock: AutomationClock;
  private generation = 0;
  private owned = false;
  private startedAt = 0;
  private loading = false;
  private disposed = false;
  private running: Promise<void> | null = null;
  private dirty = false;
  private cancelTimer: (() => void) | null = null;
  private persistence: Promise<void> = Promise.resolve();

  constructor(private readonly options: AutomationControllerOptions) {
    this.settings = structuredClone(options.settings);
    this.clock = options.clock ?? systemClock;
    const persisted = options.state ?? {};
    const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    this.runtime = {
      quietUntil: timestamp(persisted.quietUntil),
      retryUntil: timestamp(persisted.retryUntil),
      failures: Math.min(30, Math.floor(timestamp(persisted.failures))),
      lastTrackId: typeof persisted.lastTrackId === 'string' ? persisted.lastTrackId : null,
      presenceSuppressed: persisted.presenceSuppressed === true,
      sourceKey: key(this.settings),
      channelId: Number.isSafeInteger(persisted.channelId) && (persisted.channelId ?? 0) > 0 ? persisted.channelId! : null,
    };
    if (persisted.sourceKey !== undefined && persisted.sourceKey !== this.runtime.sourceKey) {
      this.runtime.retryUntil = 0;
      this.runtime.failures = 0;
      this.runtime.lastTrackId = null;
    }
  }

  get active(): boolean { return this.owned; }
  get configuration(): BotAutomationSettings { return structuredClone(this.settings); }
  get state(): AutomationRuntimeState { return { ...this.runtime }; }
  get keepChannel(): boolean { return this.settings.stayInChannel && !this.runtime.presenceSuppressed; }

  configure(settings: BotAutomationSettings): void {
    const sourceChanged = key(settings) !== key(this.settings);
    const changed = JSON.stringify(settings) !== JSON.stringify(this.settings);
    this.settings = structuredClone(settings);
    if (changed && (sourceChanged || !settings.enabled)) this.invalidate(true);
    else if (changed && this.loading && !this.owned) this.invalidate(false);
    if (sourceChanged) {
      this.runtime.sourceKey = key(settings);
      this.runtime.lastTrackId = null;
      this.resetFailures();
      this.save();
    }
    void this.reconcile();
  }

  /** Coalesce all queue, listener, timer, and connection notifications into one worker. */
  reconcile(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.dirty = true;
    if (this.running) return this.running;
    // Defer entry so synchronous notifications can share the same promise.
    this.running = Promise.resolve().then(async () => {
      while (this.dirty && !this.disposed) {
        this.dirty = false;
        await this.step();
      }
    }).catch(error => this.options.onError?.(error)).finally(() => {
      this.running = null;
      this.armTimer();
    });
    return this.running;
  }

  requestQueued(): void {
    this.invalidate(true);
    void this.reconcile();
  }

  /** Record the deadline before stop can emit synchronous playback-ended notifications. */
  manualStop(): void {
    this.runtime.quietUntil = this.clock.now() + this.settings.quietPeriodSeconds * 1000;
    this.save();
    this.invalidate(true);
    void this.reconcile();
  }

  disconnected(): void {
    this.invalidate(false);
    this.clearTimer();
  }

  suspendPresence(): void {
    this.runtime.presenceSuppressed = true;
    this.save();
    this.invalidate(true);
    this.clearTimer();
  }

  resumePresence(): void {
    this.runtime.presenceSuppressed = false;
    this.save();
    void this.reconcile();
  }

  rememberChannel(channelId: number): void {
    if (!this.keepChannel || !Number.isSafeInteger(channelId) || channelId <= 0 || channelId === this.runtime.channelId) return;
    this.runtime.channelId = channelId;
    this.save();
  }

  sourceEnded(result: { failed?: boolean } = {}): void {
    if (!this.owned) return;
    const unhealthy = result.failed || (this.settings.source?.kind === 'radio' && this.clock.now() - this.startedAt < 30_000);
    this.invalidate(false);
    if (unhealthy) this.recordFailure();
    else { this.resetFailures(); this.save(); }
    void this.reconcile();
  }

  /** Wait for ordered state writes, useful when shutting down or testing restart recovery. */
  flush(): Promise<void> { return this.persistence; }

  dispose(): void {
    this.disposed = true;
    this.invalidate(false);
    this.clearTimer();
  }

  private eligible(snapshot: AutomationSnapshot): boolean {
    return !this.disposed && this.settings.enabled && !!this.settings.source && !this.runtime.presenceSuppressed
      && snapshot.connected && !snapshot.hasRequests
      && (!this.settings.requireListeners || snapshot.humanListeners > 0)
      && this.clock.now() >= Math.max(this.runtime.quietUntil, this.runtime.retryUntil);
  }

  private async step(): Promise<void> {
    let snapshot = this.options.snapshot();
    if (!this.eligible(snapshot)) {
      // Quiet/backoff alone must never stop a human request.
      if (this.owned || this.loading) this.invalidate(this.owned && snapshot.connected);
      return;
    }
    if (this.owned) {
      if (this.clock.now() - this.startedAt >= 30_000 && this.runtime.failures) {
        this.resetFailures();
        this.save();
      }
      return;
    }
    if (snapshot.busy || !this.settings.source) return;
    const token = this.generation;
    const source = { ...this.settings.source };
    this.loading = true;
    const current = () => !this.disposed && token === this.generation;
    try {
      const item = await this.options.loadSource(source, this.runtime.lastTrackId);
      snapshot = this.options.snapshot();
      if (!current() || !this.eligible(snapshot) || snapshot.busy) return;
      this.owned = true;
      this.startedAt = this.clock.now();
      await this.options.play(item, () => current() && this.owned && this.eligible(this.options.snapshot()));
      if (!current() || !this.owned) return;
      this.runtime.lastTrackId = item.id;
      this.save();
    } catch (error) {
      if (!current()) return;
      this.invalidate(true);
      this.recordFailure();
      this.options.onError?.(error);
    } finally {
      if (token === this.generation) this.loading = false;
    }
  }

  private invalidate(stopOwned: boolean): void {
    this.generation++;
    const wasOwned = this.owned;
    this.owned = false;
    this.loading = false;
    if (stopOwned && wasOwned) this.options.stop();
  }

  private resetFailures(): void {
    this.runtime.failures = 0;
    this.runtime.retryUntil = 0;
  }

  private recordFailure(): void {
    this.runtime.failures = Math.min(this.runtime.failures + 1, 30);
    const seconds = Math.min(this.settings.retryMaxSeconds, this.settings.retryBaseSeconds * 2 ** (this.runtime.failures - 1));
    this.runtime.retryUntil = this.clock.now() + seconds * 1000;
    this.save();
  }

  private save(): void {
    const state = this.state;
    this.persistence = this.persistence.then(() => this.options.persist(state)).catch(error => this.options.onError?.(error));
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private armTimer(): void {
    this.clearTimer();
    if (this.disposed || !this.options.snapshot().connected || this.runtime.presenceSuppressed) return;
    const now = this.clock.now();
    const deadline = this.owned && this.runtime.failures
      ? this.startedAt + 30_000
      : Math.max(this.runtime.quietUntil, this.runtime.retryUntil);
    if (deadline > now) this.cancelTimer = this.clock.setTimer(() => {
      this.cancelTimer = null;
      void this.reconcile();
    }, Math.min(deadline - now, 2_147_483_647));
  }
}
