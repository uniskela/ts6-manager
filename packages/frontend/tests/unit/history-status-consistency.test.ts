import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActivityJournalStatus } from '@ts6/common';
import {
  captureStatusLabel,
  connectionSidScopeKey,
  historyRefreshPresentation,
  nextScopedCursorStack,
  resolveCaptureStatusDisplay,
} from '../../src/lib/history-status-consistency.ts';

function statusRow(
  overrides: Partial<ActivityJournalStatus> & Pick<ActivityJournalStatus, 'serverConfigId' | 'virtualServerId' | 'status'>,
): ActivityJournalStatus {
  return {
    enabled: overrides.status !== 'disabled',
    queueDepth: 0,
    queueCapacity: 500,
    droppedEvents: 0,
    lastError: null,
    lastPersistedAt: null,
    sshConnected: true,
    sshRegistered: true,
    connectionGeneration: 1,
    reconnectAttempt: 0,
    nextRetryAt: null,
    ...overrides,
  };
}

describe('connectionSidScopeKey / nextScopedCursorStack', () => {
  it('builds a stable scope key', () => {
    assert.equal(connectionSidScopeKey(1, 2), '1:2');
    assert.equal(connectionSidScopeKey(null, undefined), 'none:none');
  });

  it('resets the cursor stack immediately when scope changes', () => {
    const previous = { scopeKey: '1:1', cursorStack: [null, 'cursor-a'] as (string | null)[] };
    const next = nextScopedCursorStack(previous, '1:2', [null]);
    assert.deepEqual(next, { scopeKey: '1:2', cursorStack: [null] });
  });

  it('preserves the cursor stack for the same scope', () => {
    const previous = { scopeKey: '1:1', cursorStack: [null, 'cursor-a'] as (string | null)[] };
    const next = nextScopedCursorStack(previous, '1:1', [null]);
    assert.equal(next, previous);
    assert.deepEqual(next.cursorStack, [null, 'cursor-a']);
  });
});

describe('resolveCaptureStatusDisplay', () => {
  it('returns unknown before any successful status payload', () => {
    assert.deepEqual(
      resolveCaptureStatusDisplay({
        configId: 1,
        sid: 1,
        statuses: undefined,
        statusQueryStatus: 'pending',
        hasStatusData: false,
      }),
      { kind: 'unknown' },
    );
  });

  it('does not default a missing pair to Disabled while still unknown', () => {
    assert.equal(
      captureStatusLabel(
        resolveCaptureStatusDisplay({
          configId: 1,
          sid: 1,
          statuses: undefined,
          statusQueryStatus: 'pending',
          hasStatusData: false,
        }),
      ),
      'Unknown',
    );
  });

  it('treats an absent pair after success as Disabled', () => {
    assert.deepEqual(
      resolveCaptureStatusDisplay({
        configId: 1,
        sid: 2,
        statuses: [statusRow({ serverConfigId: 1, virtualServerId: 1, status: 'capturing' })],
        statusQueryStatus: 'success',
        hasStatusData: true,
      }),
      { kind: 'current', status: 'disabled' },
    );
  });

  it('returns current capturing when the pair is present', () => {
    assert.deepEqual(
      resolveCaptureStatusDisplay({
        configId: 1,
        sid: 1,
        statuses: [statusRow({ serverConfigId: 1, virtualServerId: 1, status: 'capturing' })],
        statusQueryStatus: 'success',
        hasStatusData: true,
      }),
      { kind: 'current', status: 'capturing' },
    );
  });

  it('marks last-known status stale after a failed refresh', () => {
    const display = resolveCaptureStatusDisplay({
      configId: 1,
      sid: 1,
      statuses: [statusRow({ serverConfigId: 1, virtualServerId: 1, status: 'capturing' })],
      statusQueryStatus: 'error',
      hasStatusData: true,
    });
    assert.deepEqual(display, { kind: 'stale', status: 'capturing' });
    assert.equal(captureStatusLabel(display), 'Capturing (stale)');
  });

  it('labels interrupted recovery separately from plain Interrupted', () => {
    const display = resolveCaptureStatusDisplay({
      configId: 1,
      sid: 1,
      statuses: [
        statusRow({
          serverConfigId: 1,
          virtualServerId: 1,
          status: 'interrupted',
          reconnectAttempt: 2,
        }),
      ],
      statusQueryStatus: 'success',
      hasStatusData: true,
    });
    assert.equal(
      captureStatusLabel(display, { reconnectAttempt: 2 }),
      'Interrupted — reconnecting',
    );
  });

  it('returns unknown when a failed refresh has no retained payload', () => {
    assert.deepEqual(
      resolveCaptureStatusDisplay({
        configId: 1,
        sid: 1,
        statuses: undefined,
        statusQueryStatus: 'error',
        hasStatusData: false,
      }),
      { kind: 'unknown' },
    );
  });
});

describe('historyRefreshPresentation', () => {
  it('hides Live and uses degraded copy when a refresh failed', () => {
    const presentation = historyRefreshPresentation({
      isFetching: false,
      hasError: true,
      livePolling: true,
    });
    assert.equal(presentation.tone, 'degraded');
    assert.equal(presentation.showLiveBadge, false);
    assert.equal(presentation.degradedLabel, 'History updates interrupted');
  });

  it('shows Live only while polling without error', () => {
    const live = historyRefreshPresentation({
      isFetching: false,
      hasError: false,
      livePolling: true,
    });
    assert.equal(live.showLiveBadge, true);
    assert.equal(live.idleLabel, 'Live history active');

    const staticOk = historyRefreshPresentation({
      isFetching: false,
      hasError: false,
      livePolling: false,
    });
    assert.equal(staticOk.showLiveBadge, false);
    assert.equal(staticOk.idleLabel, 'History up to date');
  });

  it('suppresses Live while a fetch is in flight', () => {
    const presentation = historyRefreshPresentation({
      isFetching: true,
      hasError: false,
      livePolling: true,
    });
    assert.equal(presentation.showLiveBadge, false);
  });
});
