import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVITY_JOURNAL_HISTORY_REFETCH_MS,
  activityJournalHistoryRefetchInterval,
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

  it('polls while connecting', () => {
    assert.equal(
      activityJournalHistoryRefetchInterval({
        enabled: true,
        status: 'connecting',
        onNewestPage: true,
      }),
      ACTIVITY_JOURNAL_HISTORY_REFETCH_MS,
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
