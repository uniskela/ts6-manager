import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  consumePageEntryAttempt,
  decideGlobalPageEntryScan,
  expensiveDiagnosticQueryOptions,
  isExpensiveDiagnosticQuery,
  invalidateAfterPwaRecovery,
  resetPageEntryAttemptsForTests,
  RUNTIME_MEDIA_DIAGNOSTICS_SCOPE,
  shouldScanOnTrigger,
} from '../../src/lib/demand-driven-query-policy.ts';
import {
  RUNTIME_MEDIA_NOT_CHECKED,
  RUNTIME_MEDIA_YTDLP_UPDATE_HINT,
  runtimeMediaOverallLabel,
  runtimeMediaPrerequisiteMessage,
} from '../../src/lib/runtime-media-guidance.ts';
import type { RuntimeMediaStageResult } from '@ts6/common';

describe('runtime-media diagnostics policy', () => {
  beforeEach(() => {
    resetPageEntryAttemptsForTests();
  });

  it('classifies runtime-media-diagnostics as expensive', () => {
    assert.equal(
      isExpensiveDiagnosticQuery({ queryKey: ['runtime-media-diagnostics'] }),
      true,
    );
    assert.equal(
      isExpensiveDiagnosticQuery({
        queryKey: ['music-bots'],
        meta: { demandDriven: 'ordinary' },
      }),
      false,
    );
    assert.equal(expensiveDiagnosticQueryOptions.refetchOnMount, false);
    assert.equal(expensiveDiagnosticQueryOptions.refetchOnWindowFocus, false);
    assert.equal(expensiveDiagnosticQueryOptions.refetchOnReconnect, false);
  });

  it('authorizes only page entry and manual refresh for probes', () => {
    assert.equal(shouldScanOnTrigger('page-entry-authorized'), true);
    assert.equal(shouldScanOnTrigger('manual-refresh'), true);
    assert.equal(shouldScanOnTrigger('idle-interval'), false);
    assert.equal(shouldScanOnTrigger('pwa-recovery'), false);
    assert.equal(shouldScanOnTrigger('window-focus'), false);
  });

  it('global page-entry is one-shot and offline does not authorize a probe', () => {
    const online = decideGlobalPageEntryScan({
      scope: RUNTIME_MEDIA_DIAGNOSTICS_SCOPE,
      online: true,
    });
    assert.equal(online.action, 'authorize-entry-scan');
    if (online.action === 'authorize-entry-scan') {
      consumePageEntryAttempt(online.scope, false);
    }
    assert.equal(
      decideGlobalPageEntryScan({ scope: RUNTIME_MEDIA_DIAGNOSTICS_SCOPE, online: true }).action,
      'skip',
    );

    resetPageEntryAttemptsForTests();
    const offline = decideGlobalPageEntryScan({
      scope: RUNTIME_MEDIA_DIAGNOSTICS_SCOPE,
      online: false,
    });
    assert.equal(offline.action, 'skip');
    if (offline.action === 'skip') assert.equal(offline.reason, 'offline');
  });

  it('PWA recovery marks expensive diagnostics without refetch', async () => {
    const calls: Array<{ refetchType?: string; predicate?: boolean }> = [];
    await invalidateAfterPwaRecovery({
      invalidateQueries: async (filters) => {
        calls.push({
          refetchType: filters?.refetchType,
          predicate: typeof filters?.predicate === 'function'
            ? filters.predicate({ queryKey: ['runtime-media-diagnostics'] })
            : undefined,
        });
      },
    });
    const expensiveCall = calls.find((c) => c.refetchType === 'none' && c.predicate === true);
    assert.ok(expensiveCall, 'expensive diagnostics must invalidate with refetchType none');
  });
});

describe('runtime-media guidance', () => {
  it('surfaces failed focus stages as prerequisites', () => {
    const stages: RuntimeMediaStageResult[] = [
      { id: 'yt-dlp', status: 'ok', message: 'ok' },
      { id: 'ffmpeg', status: 'ok', message: 'ok' },
      { id: 'ffprobe', status: 'ok', message: 'ok' },
      {
        id: 'sidecar',
        status: 'fail',
        message: 'Sidecar health check failed',
        code: 'sidecar_unreachable',
      },
    ];
    assert.equal(
      runtimeMediaPrerequisiteMessage(stages, ['sidecar', 'ffmpeg']),
      'Sidecar health check failed',
    );
    assert.equal(runtimeMediaPrerequisiteMessage(stages, ['yt-dlp']), null);
  });

  it('labels unchecked and overall states honestly', () => {
    assert.equal(runtimeMediaOverallLabel(undefined, true), 'Not checked');
    assert.equal(runtimeMediaOverallLabel('ok', false), 'Ready');
    assert.equal(runtimeMediaOverallLabel('partial', false), 'Partial');
    assert.equal(runtimeMediaOverallLabel('fail', false), 'Unavailable');
    assert.ok(RUNTIME_MEDIA_NOT_CHECKED.includes('Not checked'));
    assert.ok(RUNTIME_MEDIA_YTDLP_UPDATE_HINT.includes('does not self-update'));
  });
});
