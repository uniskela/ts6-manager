import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import {
  channelCoverageKey,
  channelSummaryDisplay,
  channelSummaryLabelText,
  connectionScope,
  consumePageEntryAttempt,
  decidePageEntryScan,
  deferCancelSummaryQuery,
  expensiveDiagnosticQueryOptions,
  hasConsumedPageEntryAttempt,
  invalidateAfterPwaRecovery,
  isExpensiveDiagnosticQuery,
  markExpensiveDiagnosticStale,
  pageEntryAttemptWasOffline,
  resetPageEntryAttemptsForTests,
  resetPendingSummaryCancelsForTests,
  retainSummaryQueryScope,
  shouldScanOnTrigger,
} from '../../src/lib/demand-driven-query-policy.ts';

describe('expensive diagnostic classification', () => {
  it('classifies file-summaries as expensive via key and meta', () => {
    assert.equal(
      isExpensiveDiagnosticQuery({ queryKey: ['file-summaries', 1, 1] }),
      true,
    );
    assert.equal(
      isExpensiveDiagnosticQuery({
        queryKey: ['channels', 1, 1],
        meta: { demandDriven: 'expensive-diagnostic' },
      }),
      true,
    );
    assert.equal(
      isExpensiveDiagnosticQuery({ queryKey: ['channels', 1, 1] }),
      false,
    );
    assert.equal(
      isExpensiveDiagnosticQuery({
        queryKey: ['file-summaries', 1, 1],
        meta: { demandDriven: 'ordinary' },
      }),
      false,
    );
  });

  it('only authorizes scans for page entry and manual refresh', () => {
    assert.equal(shouldScanOnTrigger('page-entry-authorized'), true);
    assert.equal(shouldScanOnTrigger('manual-refresh'), true);
    for (const trigger of [
      'pwa-recovery',
      'file-mutation',
      'channel-list-change',
      'connection-revision',
      'window-focus',
      'idle-interval',
      'config-edit',
    ] as const) {
      assert.equal(shouldScanOnTrigger(trigger), false, trigger);
    }
  });
});

describe('page-entry scan authorization', () => {
  it('authorizes one bounded attempt per connection scope when online', () => {
    const first = decidePageEntryScan({
      configId: 1,
      sid: 1,
      hasChannels: true,
      online: true,
      entryAttemptScope: null,
    });
    assert.deepEqual(first, {
      action: 'authorize-entry-scan',
      scope: connectionScope(1, 1),
    });

    const second = decidePageEntryScan({
      configId: 1,
      sid: 1,
      hasChannels: true,
      online: true,
      entryAttemptScope: connectionScope(1, 1),
    });
    assert.deepEqual(second, { action: 'skip', reason: 'already-attempted' });
  });

  it('skips offline entry without authorizing a deferred scan', () => {
    const decision = decidePageEntryScan({
      configId: 1,
      sid: 1,
      hasChannels: true,
      online: false,
      entryAttemptScope: null,
    });
    assert.deepEqual(decision, { action: 'skip', reason: 'offline' });
  });

  it('returns missing-context before offline when channels are not ready yet', () => {
    // Callers must treat offline+missing-context as a consumed cold entry (see Files.tsx).
    const decision = decidePageEntryScan({
      configId: 1,
      sid: 1,
      hasChannels: false,
      online: false,
      entryAttemptScope: null,
    });
    assert.deepEqual(decision, { action: 'skip', reason: 'missing-context' });
  });

  it('does not treat channel-list readiness alone as a second opportunity', () => {
    // Same scope already attempted — growing channel list must not re-authorize.
    const decision = decidePageEntryScan({
      configId: 1,
      sid: 1,
      hasChannels: true,
      online: true,
      entryAttemptScope: connectionScope(1, 1),
    });
    assert.equal(decision.action, 'skip');
    assert.equal(shouldScanOnTrigger('channel-list-change'), false);
  });

  it('persists page-entry attempts across remount-like reads of the same scope', () => {
    resetPageEntryAttemptsForTests();
    const scope = connectionScope(1, 1);
    assert.equal(hasConsumedPageEntryAttempt(scope), false);

    consumePageEntryAttempt(scope, true);
    assert.equal(hasConsumedPageEntryAttempt(scope), true);
    assert.equal(pageEntryAttemptWasOffline(scope), true);

    // Remount: no component ref — only the module map remains.
    const remount = decidePageEntryScan({
      configId: 1,
      sid: 1,
      hasChannels: true,
      online: true,
      entryAttemptScope: hasConsumedPageEntryAttempt(scope) ? scope : null,
    });
    assert.deepEqual(remount, { action: 'skip', reason: 'already-attempted' });

    // A different connection scope still gets one automatic opportunity.
    const otherScope = connectionScope(2, 1);
    const other = decidePageEntryScan({
      configId: 2,
      sid: 1,
      hasChannels: true,
      online: true,
      entryAttemptScope: hasConsumedPageEntryAttempt(otherScope) ? otherScope : null,
    });
    assert.equal(other.action, 'authorize-entry-scan');
  });
});

describe('deferred summary cancel (StrictMode same-scope remount)', () => {
  it('retains when the same scope is re-established before the timer fires', async () => {
    resetPendingSummaryCancelsForTests();
    let cancelCount = 0;
    const qc = {
      cancelQueries: () => {
        cancelCount += 1;
      },
    };
    const key = ['file-summaries', 1, 1] as const;

    deferCancelSummaryQuery(qc, key);
    retainSummaryQueryScope(key);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cancelCount, 0);
  });

  it('cancels after unmount when the scope is not re-established', async () => {
    resetPendingSummaryCancelsForTests();
    let cancelCount = 0;
    const qc = {
      cancelQueries: () => {
        cancelCount += 1;
      },
    };
    const key = ['file-summaries', 1, 1] as const;

    deferCancelSummaryQuery(qc, key);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cancelCount, 1);
  });

  it('cancels the prior scope when connection revision changes', async () => {
    resetPendingSummaryCancelsForTests();
    const cancelled: string[] = [];
    const qc = {
      cancelQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
        cancelled.push(String(queryKey[1]));
      },
    };
    const oldKey = ['file-summaries', 1, 1] as const;
    const newKey = ['file-summaries', 2, 1] as const;

    deferCancelSummaryQuery(qc, oldKey);
    retainSummaryQueryScope(newKey);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(cancelled, ['1']);
  });
});

describe('summary display honesty', () => {
  it('shows Not checked. when entering offline with no observation', () => {
    const display = channelSummaryDisplay({
      offlineUnchecked: true,
      isFetching: false,
      isError: false,
      hasErrorData: false,
      observation: null,
      currentChannelKey: '10,20',
      channelId: 10,
      summary: null,
      isQueryInvalidated: false,
    });
    assert.equal(display.kind, 'not-checked');
    assert.equal(channelSummaryLabelText(display), 'Not checked.');
  });

  it('labels channels outside the scanned coverage as Not scanned.', () => {
    const display = channelSummaryDisplay({
      offlineUnchecked: false,
      isFetching: false,
      isError: false,
      hasErrorData: false,
      observation: { scannedChannelKey: '10', scannedAt: 1 },
      currentChannelKey: channelCoverageKey([10, 99]),
      eligibleChannelKey: channelCoverageKey([10]),
      channelId: 99,
      summary: null,
      isQueryInvalidated: false,
    });
    assert.equal(display.kind, 'not-scanned');
    assert.equal(channelSummaryLabelText(display), 'Not scanned.');
  });

  it('keeps first-256 eligible channels ready when extras are omitted (scenario 5)', () => {
    const eligible = Array.from({ length: 256 }, (_, i) => i + 1);
    const all = [...eligible, 257];
    const displayScanned = channelSummaryDisplay({
      offlineUnchecked: false,
      isFetching: false,
      isError: false,
      hasErrorData: false,
      observation: { scannedChannelKey: channelCoverageKey(eligible), scannedAt: 1 },
      currentChannelKey: channelCoverageKey(all),
      eligibleChannelKey: channelCoverageKey(eligible),
      channelId: 1,
      summary: { complete: true },
      isQueryInvalidated: false,
    });
    assert.equal(displayScanned.kind, 'ready');

    const displayOmitted = channelSummaryDisplay({
      offlineUnchecked: false,
      isFetching: false,
      isError: false,
      hasErrorData: false,
      observation: { scannedChannelKey: channelCoverageKey(eligible), scannedAt: 1 },
      currentChannelKey: channelCoverageKey(all),
      eligibleChannelKey: channelCoverageKey(eligible),
      channelId: 257,
      summary: { notScanned: true },
      isQueryInvalidated: false,
    });
    assert.equal(displayOmitted.kind, 'not-scanned');
  });

  it('labels incomplete trees as Partial', () => {
    const display = channelSummaryDisplay({
      offlineUnchecked: false,
      isFetching: false,
      isError: false,
      hasErrorData: false,
      observation: { scannedChannelKey: '10', scannedAt: 1 },
      currentChannelKey: '10',
      eligibleChannelKey: '10',
      channelId: 10,
      summary: { complete: false },
      isQueryInvalidated: false,
    });
    assert.equal(display.kind, 'partial');
    assert.equal(channelSummaryLabelText(display), 'Partial');
  });

  it('shows Check failed. for refresh errors that retain a prior observation', () => {
    const display = channelSummaryDisplay({
      offlineUnchecked: false,
      isFetching: false,
      isError: true,
      hasErrorData: true,
      observation: { scannedChannelKey: '10', scannedAt: 1 },
      currentChannelKey: '10',
      channelId: 10,
      summary: { unavailable: true },
      isQueryInvalidated: false,
    });
    assert.equal(display.kind, 'error');
    assert.equal(channelSummaryLabelText(display), 'Check failed.');
  });

  it('keeps Not scanned. for out-of-coverage channels even when the query errored', () => {
    const display = channelSummaryDisplay({
      offlineUnchecked: false,
      isFetching: false,
      isError: true,
      hasErrorData: true,
      observation: { scannedChannelKey: '10', scannedAt: 1 },
      currentChannelKey: channelCoverageKey([10, 99]),
      channelId: 99,
      summary: null,
      isQueryInvalidated: false,
    });
    assert.equal(display.kind, 'not-scanned');
  });
});

describe('request counts (scenario 4)', () => {
  it('does not scan after PWA recovery, mutation invalidation, or channel-list change', async () => {
    let expensiveFetches = 0;
    let ordinaryFetches = 0;

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const expensiveKey = ['file-summaries', 1, 1] as const;
    const ordinaryKey = ['channels-for-files', 1, 1] as const;

    await qc.fetchQuery({
      queryKey: expensiveKey,
      queryFn: async () => {
        expensiveFetches += 1;
        return {
          summaries: [{ cid: 10, fileCount: 1, folderCount: 0, totalSize: 4 }],
          observation: { scannedChannelKey: '10', scannedAt: Date.now() },
        };
      },
      ...expensiveDiagnosticQueryOptions,
    });

    await qc.fetchQuery({
      queryKey: ordinaryKey,
      queryFn: async () => {
        ordinaryFetches += 1;
        return [{ cid: 10, channel_name: 'Lobby' }];
      },
    });

    assert.equal(expensiveFetches, 1);
    assert.equal(ordinaryFetches, 1);

    // Channel-list change: coverage becomes stale; policy forbids a scan.
    assert.equal(shouldScanOnTrigger('channel-list-change'), false);
    assert.equal(expensiveFetches, 1);

    // File mutation: mark summary stale without refetch.
    assert.equal(shouldScanOnTrigger('file-mutation'), false);
    await markExpensiveDiagnosticStale(qc, expensiveKey);
    assert.equal(expensiveFetches, 1);
    assert.equal(qc.getQueryState(expensiveKey)?.isInvalidated, true);

    // Disabled observers report isStale=false; UI must read isInvalidated from the cache.
    assert.equal(
      channelSummaryDisplay({
        offlineUnchecked: false,
        isFetching: false,
        isError: false,
        hasErrorData: false,
        observation: { scannedChannelKey: '10', scannedAt: 1 },
        currentChannelKey: '10',
        channelId: 10,
        summary: { fileCount: 1 } as { unavailable?: boolean },
        isQueryInvalidated: qc.getQueryState(expensiveKey)?.isInvalidated ?? false,
      }).kind,
      'stale-cached',
    );

    // PWA recovery: expensive stays at one fetch; ordinary may refresh when active.
    assert.equal(shouldScanOnTrigger('pwa-recovery'), false);
    await invalidateAfterPwaRecovery(qc);
    assert.equal(expensiveFetches, 1);
    assert.equal(qc.getQueryState(expensiveKey)?.isInvalidated, true);

    // Manual refresh is the explicit path that may scan again.
    assert.equal(shouldScanOnTrigger('manual-refresh'), true);
    await qc.refetchQueries({ queryKey: expensiveKey, type: 'all' });
    assert.equal(expensiveFetches, 2);

    qc.clear();
  });

  it('coalesces compatible in-flight manual refresh work on the same key', async () => {
    let expensiveFetches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const expensiveKey = ['file-summaries', 2, 1] as const;

    const fetchOnce = () =>
      qc.fetchQuery({
        queryKey: expensiveKey,
        queryFn: async () => {
          expensiveFetches += 1;
          await gate;
          return {
            summaries: [],
            observation: { scannedChannelKey: '1', scannedAt: Date.now() },
          };
        },
        ...expensiveDiagnosticQueryOptions,
      });

    const first = fetchOnce();
    const second = fetchOnce();
    release();
    await Promise.all([first, second]);

    // TanStack Query dedupes identical in-flight fetches for the same key.
    assert.equal(expensiveFetches, 1);
    qc.clear();
  });
});
