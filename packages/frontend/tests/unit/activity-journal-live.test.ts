import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVITY_JOURNAL_HISTORY_REFETCH_MS,
  ACTIVITY_JOURNAL_STATUS_IDLE_REFETCH_MS,
  ACTIVITY_JOURNAL_STATUS_RECOVERY_REFETCH_MS,
  activityJournalHistoryRefetchInterval,
  activityJournalStatusRefetchInterval,
  isActivityJournalLiveCapture,
} from '../../src/lib/activity-journal-live.ts';

describe('activityJournalHistoryRefetchInterval', () => {
  it('polls when enabled and capturing on the newest page', () => {
    assert.equal(
      activityJournalHistoryRefetchInterval({
        enabled: true,
        status: 'capturing',
        onNewestPage: true,
      }),
      ACTIVITY_JOURNAL_HISTORY_REFETCH_MS,
    );
  });

  it('does not treat connecting as Live history', () => {
    assert.equal(
      activityJournalHistoryRefetchInterval({
        enabled: true,
        status: 'connecting',
        onNewestPage: true,
      }),
      false,
    );
  });

  it('disables when capture is off', () => {
    assert.equal(
      activityJournalHistoryRefetchInterval({
        enabled: false,
        status: 'capturing',
        onNewestPage: true,
      }),
      false,
    );
  });

  it('disables on older history pages', () => {
    assert.equal(
      activityJournalHistoryRefetchInterval({
        enabled: true,
        status: 'capturing',
        onNewestPage: false,
      }),
      false,
    );
  });

  it('disables for interrupted / disabled / persistence_error', () => {
    for (const status of ['interrupted', 'disabled', 'persistence_error'] as const) {
      assert.equal(
        activityJournalHistoryRefetchInterval({
          enabled: true,
          status,
          onNewestPage: true,
        }),
        false,
        status,
      );
    }
  });
});

describe('isActivityJournalLiveCapture / status refetch', () => {
  it('marks only capturing as live', () => {
    assert.equal(isActivityJournalLiveCapture('capturing'), true);
    assert.equal(isActivityJournalLiveCapture('connecting'), false);
    assert.equal(isActivityJournalLiveCapture('interrupted'), false);
  });

  it('polls status faster while connecting or interrupted', () => {
    assert.equal(
      activityJournalStatusRefetchInterval({ enabled: true, status: 'connecting' }),
      ACTIVITY_JOURNAL_STATUS_RECOVERY_REFETCH_MS,
    );
    assert.equal(
      activityJournalStatusRefetchInterval({ enabled: true, status: 'interrupted' }),
      ACTIVITY_JOURNAL_STATUS_RECOVERY_REFETCH_MS,
    );
    assert.equal(
      activityJournalStatusRefetchInterval({ enabled: true, status: 'capturing' }),
      ACTIVITY_JOURNAL_STATUS_IDLE_REFETCH_MS,
    );
  });
});
