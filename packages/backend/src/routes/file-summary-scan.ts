/**
 * Slice 6 PR3 — bounded storage summary scans.
 *
 * Request-wide budgets, generation checks, shared-scan coalescing, and honest
 * partial / not-scanned results. Does not rewrite the SSH transport: callers
 * inject a listPath function (typically EventBridge.executeCommand → ftgetfilelist).
 */

export const FILE_SUMMARY_MAX_CHANNELS = 256;
export const FILE_SUMMARY_TTL_MS = 30_000;
export const FILE_SUMMARY_MAX_DEPTH = 32;
export const FILE_SUMMARY_MAX_ENTRIES_PER_CHANNEL = 5_000;
export const FILE_SUMMARY_MAX_COMMANDS_PER_REQUEST = 200;
export const FILE_SUMMARY_MAX_ENTRIES_PER_REQUEST = 15_000;
export const FILE_SUMMARY_DEADLINE_MS = 20_000;

export type TruncateReason =
  | 'budget-commands'
  | 'budget-entries'
  | 'deadline'
  | 'depth'
  | 'channel-entries'
  | 'generation-stale'
  | 'cancelled'
  | 'denied'
  | 'error'
  | 'channel-cap'
  | 'request-budget';

/** SSH disconnect / Query flood — must bubble to the HTTP route (not per-channel unavailable). */
export function isPropagatingFileSshTransportError(err: unknown): boolean {
  const code = Number((err as { code?: number })?.code);
  if (code === 524) return true;
  const msg = String((err as { message?: string })?.message || '');
  return (
    msg.includes('SSH not connected')
    || /SSH credentials not configured/i.test(msg)
    || /SSH authentication failed/i.test(msg)
    || /SSH host key verification failed/i.test(msg)
  );
}

export type ChannelFileSummaryComplete = {
  cid: number;
  fileCount: number;
  folderCount: number;
  totalSize: number;
  scannedAt: number;
  complete: true;
};

export type ChannelFileSummaryPartial = {
  cid: number;
  fileCount: number;
  folderCount: number;
  totalSize: number;
  scannedAt: number;
  complete: false;
  truncateReason: TruncateReason;
};

export type ChannelFileSummaryUnavailable = {
  cid: number;
  unavailable: true;
  reason?: TruncateReason;
};

export type ChannelFileSummaryNotScanned = {
  cid: number;
  notScanned: true;
  reason: TruncateReason;
};

export type ChannelFileSummaryResult =
  | ChannelFileSummaryComplete
  | ChannelFileSummaryPartial
  | ChannelFileSummaryUnavailable
  | ChannelFileSummaryNotScanned;

export type FileSummaryBudgetSnapshot = {
  deadlineMs: number;
  commandsUsed: number;
  commandsMax: number;
  entriesUsed: number;
  entriesMax: number;
  exhausted: boolean;
};

export type FileSummaryResponse = {
  /** Observation time for this request's results (not delivery time). */
  scannedAt: number;
  deliveredAt: number;
  connectionGeneration: number;
  cacheGeneration: number;
  scannedCids: number[];
  notScannedCids: number[];
  budget: FileSummaryBudgetSnapshot;
  summaries: ChannelFileSummaryResult[];
};

export type ListPathFn = (cid: number, path: string) => Promise<Record<string, string>[]>;

export type ScanRequestContext = {
  configId: number;
  sid: number;
  /** Bounded channel set (≤ FILE_SUMMARY_MAX_CHANNELS). */
  cids: number[];
  /** Channels intentionally omitted (e.g. over the 256 cap). */
  omittedCids?: number[];
  connectionGeneration: number;
  cacheGeneration: number;
  deadlineAt: number;
  maxCommands: number;
  maxEntries: number;
  maxDepth: number;
  maxEntriesPerChannel: number;
  signal?: AbortSignal;
  listPath: ListPathFn;
  getConnectionGeneration: () => number;
  getCacheGeneration: () => number;
  now?: () => number;
};

export type RequestBudget = {
  deadlineAt: number;
  maxCommands: number;
  maxEntries: number;
  commandsUsed: number;
  entriesUsed: number;
  stopScheduling: boolean;
  truncateReason: TruncateReason | null;
  now: () => number;
};

export function createRequestBudget(input: {
  deadlineAt: number;
  maxCommands: number;
  maxEntries: number;
  now?: () => number;
}): RequestBudget {
  return {
    deadlineAt: input.deadlineAt,
    maxCommands: input.maxCommands,
    maxEntries: input.maxEntries,
    commandsUsed: 0,
    entriesUsed: 0,
    stopScheduling: false,
    truncateReason: null,
    now: input.now ?? Date.now,
  };
}

export function budgetSnapshot(budget: RequestBudget, deadlineMs: number): FileSummaryBudgetSnapshot {
  return {
    deadlineMs,
    commandsUsed: budget.commandsUsed,
    commandsMax: budget.maxCommands,
    entriesUsed: budget.entriesUsed,
    entriesMax: budget.maxEntries,
    exhausted: budget.stopScheduling && budget.truncateReason !== 'cancelled' && budget.truncateReason !== 'generation-stale',
  };
}

/** Check whether another SSH command may be scheduled. */
export function assertCanSchedule(
  budget: RequestBudget,
  opts: {
    signal?: AbortSignal;
    connectionGeneration: number;
    getConnectionGeneration: () => number;
    cacheGeneration: number;
    getCacheGeneration: () => number;
  },
): TruncateReason | null {
  if (budget.stopScheduling) return budget.truncateReason ?? 'cancelled';
  if (opts.signal?.aborted) {
    budget.stopScheduling = true;
    budget.truncateReason = 'cancelled';
    return 'cancelled';
  }
  if (opts.getConnectionGeneration() !== opts.connectionGeneration) {
    budget.stopScheduling = true;
    budget.truncateReason = 'generation-stale';
    return 'generation-stale';
  }
  if (opts.getCacheGeneration() !== opts.cacheGeneration) {
    budget.stopScheduling = true;
    budget.truncateReason = 'generation-stale';
    return 'generation-stale';
  }
  if (budget.now() >= budget.deadlineAt) {
    budget.stopScheduling = true;
    budget.truncateReason = 'deadline';
    return 'deadline';
  }
  if (budget.commandsUsed >= budget.maxCommands) {
    budget.stopScheduling = true;
    budget.truncateReason = 'budget-commands';
    return 'budget-commands';
  }
  if (budget.entriesUsed >= budget.maxEntries) {
    budget.stopScheduling = true;
    budget.truncateReason = 'budget-entries';
    return 'budget-entries';
  }
  return null;
}

export function selectChannelsForSummaryScan(
  channelIds: readonly number[],
  max = FILE_SUMMARY_MAX_CHANNELS,
): { scanIds: number[]; omittedIds: number[] } {
  if (channelIds.length <= max) {
    return { scanIds: [...channelIds], omittedIds: [] };
  }
  return {
    scanIds: channelIds.slice(0, max),
    omittedIds: channelIds.slice(max),
  };
}

export function channelCoverageKey(channelIds: readonly number[]): string {
  return channelIds.join(',');
}

type InFlightEntry = {
  scanId: number;
  cacheGeneration: number;
  waiters: number;
  /** When true, no further SSH work should be scheduled for this scan. */
  stopScheduling: boolean;
  promise: Promise<ChannelFileSummaryResult>;
};

/**
 * Per-connection coordinator: TTL cache, generation counters, and coalesced
 * per-channel scans. Shared waiters keep work alive when one caller disconnects.
 */
export class FileSummaryScanCoordinator {
  private cache = new Map<string, ChannelFileSummaryComplete>();
  private inFlight = new Map<string, InFlightEntry>();
  private cacheGenerations = new Map<string, number>();
  private nextScanId = 1;

  private scopeKey(configId: number, sid: number): string {
    return `${configId}:${sid}`;
  }

  private channelKey(configId: number, sid: number, cid: number): string {
    return `${configId}:${sid}:${cid}`;
  }

  getCacheGeneration(configId: number, sid: number): number {
    return this.cacheGenerations.get(this.scopeKey(configId, sid)) ?? 0;
  }

  /** Bump cache generation and drop complete cache entries for this scope. */
  invalidateScope(configId: number, sid: number): number {
    const scope = this.scopeKey(configId, sid);
    const next = (this.cacheGenerations.get(scope) ?? 0) + 1;
    this.cacheGenerations.set(scope, next);
    const prefix = `${configId}:${sid}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
    // Mark in-flight scans so they stop scheduling; do not delete newer entries.
    for (const [key, entry] of this.inFlight) {
      if (key.startsWith(prefix) && entry.cacheGeneration < next) {
        entry.stopScheduling = true;
      }
    }
    return next;
  }

  invalidateChannel(configId: number, sid: number, cid: number): void {
    this.cache.delete(this.channelKey(configId, sid, cid));
    this.invalidateScope(configId, sid);
  }

  /** Test helper. */
  resetForTests(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.cacheGenerations.clear();
    this.nextScanId = 1;
  }

  async runRequest(ctx: ScanRequestContext): Promise<FileSummaryResponse> {
    const now = ctx.now ?? Date.now;
    const startedAt = now();
    const deadlineMs = Math.max(0, ctx.deadlineAt - startedAt);
    const budget = createRequestBudget({
      deadlineAt: ctx.deadlineAt,
      maxCommands: ctx.maxCommands,
      maxEntries: ctx.maxEntries,
      now,
    });

    const omitted = ctx.omittedCids ?? [];
    const summaries: ChannelFileSummaryResult[] = [];
    const scannedCids: number[] = [];
    const notScannedCids: number[] = [...omitted];

    for (const cid of omitted) {
      summaries.push({ cid, notScanned: true, reason: 'channel-cap' });
    }

    for (const cid of ctx.cids) {
      const gate = assertCanSchedule(budget, {
        signal: ctx.signal,
        connectionGeneration: ctx.connectionGeneration,
        getConnectionGeneration: ctx.getConnectionGeneration,
        cacheGeneration: ctx.cacheGeneration,
        getCacheGeneration: ctx.getCacheGeneration,
      });
      if (gate) {
        // Remaining channels: honest not-scanned — no unlimited batches.
        for (const rest of ctx.cids.slice(ctx.cids.indexOf(cid))) {
          notScannedCids.push(rest);
          summaries.push({
            cid: rest,
            notScanned: true,
            reason: gate === 'cancelled' || gate === 'generation-stale' ? gate : 'request-budget',
          });
        }
        break;
      }

      const result = await this.getChannelSummary(ctx, cid, budget);
      summaries.push(result);
      if ('notScanned' in result && result.notScanned) {
        notScannedCids.push(cid);
      } else {
        scannedCids.push(cid);
      }
    }

    // Prefer the earliest complete/partial scannedAt; fall back to request start.
    let scannedAt = startedAt;
    for (const s of summaries) {
      if ('scannedAt' in s && typeof s.scannedAt === 'number') {
        scannedAt = Math.min(scannedAt, s.scannedAt);
      }
    }

    return {
      scannedAt,
      deliveredAt: now(),
      connectionGeneration: ctx.connectionGeneration,
      cacheGeneration: ctx.cacheGeneration,
      scannedCids,
      notScannedCids,
      budget: budgetSnapshot(budget, deadlineMs),
      summaries,
    };
  }

  private async getChannelSummary(
    ctx: ScanRequestContext,
    cid: number,
    budget: RequestBudget,
  ): Promise<ChannelFileSummaryResult> {
    const key = this.channelKey(ctx.configId, ctx.sid, cid);
    const cached = this.cache.get(key);
    const now = ctx.now ?? Date.now;
    if (cached && now() - cached.scannedAt < FILE_SUMMARY_TTL_MS) {
      return cached;
    }

    let entry = this.inFlight.get(key);
    // Do not join an obsolete or already-cancelled in-flight scan.
    if (entry && (entry.cacheGeneration !== ctx.cacheGeneration || entry.stopScheduling)) {
      entry.stopScheduling = true;
      entry = undefined;
    }
    if (!entry) {
      const scanId = this.nextScanId++;
      const cacheGeneration = ctx.cacheGeneration;
      // Placeholder so scanChannel can read stopScheduling via the map entry.
      // Overwrites any obsolete entry; the old finally must not delete this newer one.
      const placeholder: InFlightEntry = {
        scanId,
        cacheGeneration,
        waiters: 0,
        stopScheduling: false,
        promise: null as unknown as Promise<ChannelFileSummaryResult>,
      };
      this.inFlight.set(key, placeholder);

      placeholder.promise = this.scanChannel(ctx, cid, budget, () => {
        const current = this.inFlight.get(key);
        return Boolean(
          current?.stopScheduling
          || current === undefined
          || current.scanId !== scanId,
        );
      }).then((result) => {
        // Publish only complete results for the still-current in-flight entry and cache gen.
        const current = this.inFlight.get(key);
        const cacheGenOk = ctx.getCacheGeneration() === cacheGeneration;
        const isCurrentEntry = current?.scanId === scanId;
        if (
          'complete' in result
          && result.complete === true
          && cacheGenOk
          && isCurrentEntry
        ) {
          this.cache.set(key, result);
        }
        return result;
      }).finally(() => {
        const current = this.inFlight.get(key);
        // Old cleanup must not remove a newer in-flight entry.
        if (current?.scanId === scanId) {
          this.inFlight.delete(key);
        }
      });

      entry = placeholder;
    }

    entry.waiters += 1;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      entry!.waiters = Math.max(0, entry!.waiters - 1);
    };
    const onAbort = () => {
      // Decrement immediately so a later aborting peer sees the true active count.
      release();
      // One disconnected caller must not cancel work still needed by others.
      if (entry!.waiters === 0) {
        entry!.stopScheduling = true;
      }
    };
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      return await entry.promise;
    } finally {
      release();
      if (ctx.signal) {
        ctx.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  private async scanChannel(
    ctx: ScanRequestContext,
    cid: number,
    budget: RequestBudget,
    isStopped: () => boolean,
  ): Promise<ChannelFileSummaryComplete | ChannelFileSummaryPartial | ChannelFileSummaryUnavailable> {
    const now = ctx.now ?? Date.now;
    let fileCount = 0;
    let folderCount = 0;
    let totalSize = 0;
    let channelEntries = 0;
    let truncateReason: TruncateReason | null = null;
    const visited = new Set<string>();

    const scan = async (path: string, depth: number): Promise<void> => {
      if (truncateReason) return;
      if (isStopped()) {
        truncateReason = 'cancelled';
        return;
      }
      const gate = assertCanSchedule(budget, {
        signal: undefined, // waiter-level abort handled via isStopped / entry.stopScheduling
        connectionGeneration: ctx.connectionGeneration,
        getConnectionGeneration: ctx.getConnectionGeneration,
        cacheGeneration: ctx.cacheGeneration,
        getCacheGeneration: ctx.getCacheGeneration,
      });
      if (gate) {
        truncateReason = gate;
        return;
      }
      if (depth > ctx.maxDepth) {
        truncateReason = 'depth';
        return;
      }
      if (visited.has(path)) return;
      visited.add(path);

      budget.commandsUsed += 1;
      let entries: Record<string, string>[];
      try {
        entries = await ctx.listPath(cid, path);
      } catch (err: unknown) {
        const code = (err as { code?: number })?.code;
        if (code === 1281) {
          entries = [];
        } else if (code === 2568 || code === 2567 || code === 1796) {
          truncateReason = 'denied';
          throw Object.assign(new Error('denied'), { summaryDenied: true });
        } else {
          throw err;
        }
      }

      // Allow the transmitted command to finish; check before scheduling children.
      if (isStopped()) {
        truncateReason = truncateReason ?? 'cancelled';
        return;
      }

      for (const entry of entries) {
        if (truncateReason) return;
        const name = String(entry.name || '');
        if (!name || name === '.' || name === '..') continue;

        channelEntries += 1;
        budget.entriesUsed += 1;
        if (channelEntries > ctx.maxEntriesPerChannel) {
          truncateReason = 'channel-entries';
          return;
        }
        if (budget.entriesUsed > budget.maxEntries) {
          truncateReason = 'budget-entries';
          budget.stopScheduling = true;
          budget.truncateReason = 'budget-entries';
          return;
        }

        if (String(entry.type) === '1') {
          folderCount += 1;
          const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
          await scan(childPath, depth + 1);
        } else if (String(entry.type) === '0') {
          fileCount += 1;
          const size = Number(entry.size);
          if (Number.isFinite(size) && size > 0) totalSize += size;
        }
      }
    };

    try {
      await scan('/', 0);
    } catch (err: unknown) {
      if ((err as { summaryDenied?: boolean })?.summaryDenied) {
        return { cid, unavailable: true, reason: 'denied' };
      }
      // Let SSH disconnect / flood reach the route mapper (503), not a 200 unavailable row.
      if (isPropagatingFileSshTransportError(err)) {
        throw err;
      }
      return { cid, unavailable: true, reason: 'error' };
    }

    const scannedAt = now();

    // Obsolete / cancelled completions are not published as complete cache entries.
    if (truncateReason === 'generation-stale' || truncateReason === 'cancelled') {
      return {
        cid,
        fileCount,
        folderCount,
        totalSize,
        scannedAt,
        complete: false,
        truncateReason,
      };
    }

    if (truncateReason) {
      return {
        cid,
        fileCount,
        folderCount,
        totalSize,
        scannedAt,
        complete: false,
        truncateReason,
      };
    }

    return {
      cid,
      fileCount,
      folderCount,
      totalSize,
      scannedAt,
      complete: true,
    };
  }
}

/** Shared process-wide coordinator (routes + tests may construct their own). */
export const fileSummaryScanCoordinator = new FileSummaryScanCoordinator();

/** Build an AbortSignal that fires when the HTTP client disconnects early. */
export function abortSignalFromRequest(
  req: {
    aborted?: boolean;
    on: (event: string, listener: () => void) => void;
    removeListener: (event: string, listener: () => void) => void;
  },
  res?: {
    writableFinished?: boolean;
    once: (event: string, listener: () => void) => void;
    removeListener: (event: string, listener: () => void) => void;
  },
): AbortSignal {
  const ac = new AbortController();
  if (req.aborted) {
    ac.abort();
    return ac.signal;
  }

  // On Node 20, IncomingMessage `close` fires on normal request completion too,
  // so disconnect detection must use the response stream instead.
  const cleanup = () => {
    req.removeListener('aborted', abort);
    res?.removeListener('close', onResponseClose);
    res?.removeListener('finish', cleanup);
  };
  const abort = () => {
    if (!ac.signal.aborted) ac.abort();
    cleanup();
  };
  const onResponseClose = () => {
    if (!res?.writableFinished) abort();
    else cleanup();
  };

  req.on('aborted', abort);
  res?.once('close', onResponseClose);
  res?.once('finish', cleanup);
  return ac.signal;
}
