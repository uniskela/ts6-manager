/** Typed storage-summary payload (Slice 6 PR3). Mirrors backend file-summary-scan. */

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

export type ChannelFileSummaryResult =
  | {
      cid: number;
      fileCount: number;
      folderCount: number;
      totalSize: number;
      scannedAt: number;
      complete: true;
    }
  | {
      cid: number;
      fileCount: number;
      folderCount: number;
      totalSize: number;
      scannedAt: number;
      complete: false;
      truncateReason: TruncateReason;
    }
  | {
      cid: number;
      unavailable: true;
      reason?: TruncateReason;
    }
  | {
      cid: number;
      notScanned: true;
      reason: TruncateReason;
    };

export type FileSummaryBudgetSnapshot = {
  deadlineMs: number;
  commandsUsed: number;
  commandsMax: number;
  entriesUsed: number;
  entriesMax: number;
  exhausted: boolean;
};

export type FileSummaryResponse = {
  scannedAt: number;
  deliveredAt: number;
  connectionGeneration: number;
  cacheGeneration: number;
  scannedCids: number[];
  notScannedCids: number[];
  budget: FileSummaryBudgetSnapshot;
  summaries: ChannelFileSummaryResult[];
};

/** Max channels included in one summary scan (matches backend). */
export const FILE_SUMMARY_MAX_CHANNELS = 256;

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

export function isCountedSummary(
  summary: ChannelFileSummaryResult | null | undefined,
): summary is Extract<ChannelFileSummaryResult, { fileCount: number }> {
  return Boolean(summary && 'fileCount' in summary);
}

export function isPartialSummary(
  summary: ChannelFileSummaryResult | null | undefined,
): boolean {
  return Boolean(summary && 'complete' in summary && summary.complete === false);
}
