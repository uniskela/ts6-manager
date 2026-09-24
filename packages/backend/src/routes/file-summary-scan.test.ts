import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  FILE_SUMMARY_MAX_CHANNELS,
  FileSummaryScanCoordinator,
  selectChannelsForSummaryScan,
  type ListPathFn,
} from './file-summary-scan.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('selectChannelsForSummaryScan (scenario 5)', () => {
  it('keeps ≤256 channels fully eligible', () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const { scanIds, omittedIds } = selectChannelsForSummaryScan(ids);
    assert.deepEqual(scanIds, ids);
    assert.deepEqual(omittedIds, []);
  });

  it('bounds 257 channels and labels the remainder omitted', () => {
    const ids = Array.from({ length: 257 }, (_, i) => i + 1);
    const { scanIds, omittedIds } = selectChannelsForSummaryScan(ids, FILE_SUMMARY_MAX_CHANNELS);
    assert.equal(scanIds.length, 256);
    assert.equal(omittedIds.length, 1);
    assert.equal(omittedIds[0], 257);
    assert.equal(scanIds[255], 256);
  });
});

describe('FileSummaryScanCoordinator', () => {
  let coordinator: FileSummaryScanCoordinator;
  let connectionGeneration: number;
  let listCalls: Array<{ cid: number; path: string }>;

  beforeEach(() => {
    coordinator = new FileSummaryScanCoordinator();
    connectionGeneration = 1;
    listCalls = [];
  });

  function listPathFactory(tree: Record<string, Record<string, string>[]>): ListPathFn {
    return async (cid, path) => {
      listCalls.push({ cid, path });
      return tree[path] ?? [];
    };
  }

  function baseCtx(overrides: Partial<Parameters<FileSummaryScanCoordinator['runRequest']>[0]> = {}) {
    const now = overrides.now ?? (() => Date.now());
    const cacheGeneration = coordinator.getCacheGeneration(1, 1);
    return {
      configId: 1,
      sid: 1,
      cids: [10],
      connectionGeneration,
      cacheGeneration,
      deadlineAt: now() + 20_000,
      maxCommands: 200,
      maxEntries: 15_000,
      maxDepth: 32,
      maxEntriesPerChannel: 5_000,
      listPath: listPathFactory({
        '/': [
          { name: 'a.txt', size: '10', type: '0' },
          { name: 'dir', size: '0', type: '1' },
        ],
        '/dir': [{ name: 'b.txt', size: '20', type: '0' }],
      }),
      getConnectionGeneration: () => connectionGeneration,
      getCacheGeneration: () => coordinator.getCacheGeneration(1, 1),
      now,
      ...overrides,
    };
  }

  it('returns complete summaries and preserves scannedAt on cache hit', async () => {
    let clock = 1_000;
    const ctx = baseCtx({ now: () => clock });
    const first = await coordinator.runRequest(ctx);
    assert.equal(first.summaries.length, 1);
    const row = first.summaries[0];
    assert.ok('complete' in row && row.complete === true);
    assert.equal(row.fileCount, 2);
    assert.equal(row.folderCount, 1);
    assert.equal(row.totalSize, 30);
    assert.equal(row.scannedAt, 1_000);

    clock = 1_500;
    const second = await coordinator.runRequest({
      ...ctx,
      cacheGeneration: coordinator.getCacheGeneration(1, 1),
      now: () => clock,
    });
    const cached = second.summaries[0];
    assert.ok('scannedAt' in cached);
    assert.equal(cached.scannedAt, 1_000);
    assert.notEqual(second.deliveredAt, cached.scannedAt);
  });

  it('scenario 5: omitted channels beyond the cap are Not scanned', async () => {
    const ids = Array.from({ length: 257 }, (_, i) => i + 1);
    const { scanIds, omittedIds } = selectChannelsForSummaryScan(ids);
    // Only scan first channel to keep the test light; omit the rest as channel-cap.
    const response = await coordinator.runRequest(baseCtx({
      cids: scanIds.slice(0, 1),
      omittedCids: [...omittedIds, ...scanIds.slice(1)],
      listPath: listPathFactory({
        '/': [{ name: 'only.txt', size: '1', type: '0' }],
      }),
    }));
    assert.ok(response.notScannedCids.includes(257));
    const omitted = response.summaries.find((s) => s.cid === 257);
    assert.ok(omitted && 'notScanned' in omitted && omitted.notScanned);
    assert.equal(omitted.reason, 'channel-cap');
  });

  it('scenario 6: invalidate during scan prevents caching the completion', async () => {
    let releaseList: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseList = resolve; });
    let listed = 0;

    const scanPromise = coordinator.runRequest(baseCtx({
      listPath: async () => {
        listed += 1;
        if (listed === 1) await gate;
        return [{ name: 'a.txt', size: '5', type: '0' }];
      },
    }));

    // Wait until the first SSH command is in flight, then invalidate.
    await delay(20);
    assert.equal(listed, 1);
    coordinator.invalidateScope(1, 1);
    releaseList!();

    const response = await scanPromise;
    const row = response.summaries[0];
    assert.ok(row);
    // Must not land as a complete cache entry.
    assert.ok(!('complete' in row && row.complete === true));

    // A fresh request after invalidate must re-list (no poisoned complete cache).
    listCalls = [];
    const after = await coordinator.runRequest(baseCtx({
      cacheGeneration: coordinator.getCacheGeneration(1, 1),
      listPath: async (cid, path) => {
        listCalls.push({ cid, path });
        return [{ name: 'fresh.txt', size: '9', type: '0' }];
      },
    }));
    assert.ok(listCalls.length >= 1);
    const fresh = after.summaries[0];
    assert.ok('complete' in fresh && fresh.complete === true);
    assert.equal(fresh.fileCount, 1);
    assert.equal(fresh.totalSize, 9);
  });

  it('scenario 7: shared scan — one cancel does not deny the other waiter', async () => {
    let releaseList: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseList = resolve; });
    let listed = 0;

    const listPath: ListPathFn = async () => {
      listed += 1;
      if (listed === 1) await gate;
      return [{ name: 'shared.txt', size: '4', type: '0' }];
    };

    const acA = new AbortController();
    const acB = new AbortController();

    const a = coordinator.runRequest(baseCtx({ signal: acA.signal, listPath }));
    // Let A start the in-flight scan.
    await delay(20);
    assert.equal(listed, 1);

    const b = coordinator.runRequest(baseCtx({
      signal: acB.signal,
      listPath,
      cacheGeneration: coordinator.getCacheGeneration(1, 1),
    }));
    await delay(20);

    // A disconnects; B still needs the result.
    acA.abort();
    releaseList!();

    const [resultA, resultB] = await Promise.all([a, b]);
    // B must receive a usable counted result.
    const rowB = resultB.summaries[0];
    assert.ok('fileCount' in rowB);
    assert.equal(rowB.fileCount, 1);
    // Only one underlying list for the shared root (coalesced).
    assert.equal(listed, 1);
    // A may see cancelled/partial or the shared completion depending on timing;
    // it must not tear down B's result.
    assert.ok(resultA.summaries[0]);
  });

  it('scenario 8: exhausting the command budget stops further scheduling', async () => {
    // Deep-ish tree: each directory listing is one command.
    const tree: Record<string, Record<string, string>[]> = {
      '/': [
        { name: 'd1', size: '0', type: '1' },
        { name: 'd2', size: '0', type: '1' },
        { name: 'd3', size: '0', type: '1' },
      ],
      '/d1': [{ name: 'f.txt', size: '1', type: '0' }],
      '/d2': [{ name: 'f.txt', size: '1', type: '0' }],
      '/d3': [{ name: 'f.txt', size: '1', type: '0' }],
    };

    const response = await coordinator.runRequest(baseCtx({
      cids: [10, 20],
      maxCommands: 2,
      listPath: listPathFactory(tree),
    }));

    assert.ok(response.budget.commandsUsed <= 2);
    assert.ok(response.budget.exhausted || response.summaries.some((s) => 'notScanned' in s || ('complete' in s && s.complete === false)));

    // Channel 20 must not be fully scanned after budget exhaustion on channel 10.
    const second = response.summaries.find((s) => s.cid === 20);
    assert.ok(second);
    assert.ok(
      ('notScanned' in second && second.notScanned)
      || ('complete' in second && second.complete === false),
      'remaining work must be labelled incomplete / not scanned',
    );

    // No additional commands beyond the cap.
    assert.ok(listCalls.length <= 2, `expected ≤2 list calls, got ${listCalls.length}`);
  });

  it('never caches partial totals as complete', async () => {
    const tree: Record<string, Record<string, string>[]> = {
      '/': [
        { name: 'd1', size: '0', type: '1' },
        { name: 'keep.txt', size: '3', type: '0' },
      ],
      '/d1': [{ name: 'deep.txt', size: '7', type: '0' }],
    };
    const partial = await coordinator.runRequest(baseCtx({
      maxCommands: 1,
      listPath: listPathFactory(tree),
    }));
    const row = partial.summaries[0];
    assert.ok('complete' in row && row.complete === false);

    // Next request with room in the budget must not reuse partial as complete.
    listCalls = [];
    const full = await coordinator.runRequest(baseCtx({
      cacheGeneration: coordinator.getCacheGeneration(1, 1),
      maxCommands: 10,
      listPath: listPathFactory(tree),
    }));
    assert.ok(listCalls.length >= 2);
    const fullRow = full.summaries[0];
    assert.ok('complete' in fullRow && fullRow.complete === true);
    assert.equal(fullRow.fileCount, 2);
  });

  it('old in-flight cleanup does not remove a newer scan entry', async () => {
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    let phase: 'old' | 'new' = 'old';

    const oldPromise = coordinator.runRequest(baseCtx({
      listPath: async () => {
        if (phase === 'old') await oldGate;
        return [{ name: 'old.txt', size: '1', type: '0' }];
      },
    }));
    await delay(20);

    // Invalidate so the old scan must not publish; start a newer scan for the same channel.
    coordinator.invalidateScope(1, 1);
    phase = 'new';
    const newer = await coordinator.runRequest(baseCtx({
      cacheGeneration: coordinator.getCacheGeneration(1, 1),
      listPath: async () => [{ name: 'new.txt', size: '2', type: '0' }],
    }));
    const newerRow = newer.summaries[0];
    assert.ok('complete' in newerRow && newerRow.complete === true);
    assert.equal(newerRow.totalSize, 2);

    releaseOld!();
    await oldPromise;

    // Cache must still hold the newer complete observation.
    const hit = await coordinator.runRequest(baseCtx({
      cacheGeneration: coordinator.getCacheGeneration(1, 1),
      listPath: async () => {
        throw new Error('should not list — cache must retain newer entry');
      },
    }));
    const cached = hit.summaries[0];
    assert.ok('complete' in cached && cached.complete === true);
    assert.equal(cached.totalSize, 2);
  });

  it('marks denied trees unavailable without inventing zero totals', async () => {
    const response = await coordinator.runRequest(baseCtx({
      listPath: async () => {
        const err = new Error('insufficient client permissions') as Error & { code: number };
        err.code = 2568;
        throw err;
      },
    }));
    const row = response.summaries[0];
    assert.ok('unavailable' in row && row.unavailable);
    assert.equal(row.reason, 'denied');
  });
});
