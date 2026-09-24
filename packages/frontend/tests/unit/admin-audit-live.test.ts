import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ADMIN_AUDIT_HISTORY_REFETCH_MS,
  adminAuditHistoryRefetchInterval,
} from '../../src/lib/admin-audit-live.ts';

describe('adminAuditHistoryRefetchInterval', () => {
  it('polls on the newest page', () => {
    assert.equal(
      adminAuditHistoryRefetchInterval({ onNewestPage: true }),
      ADMIN_AUDIT_HISTORY_REFETCH_MS,
    );
  });

  it('disables on older history pages', () => {
    assert.equal(
      adminAuditHistoryRefetchInterval({ onNewestPage: false }),
      false,
    );
  });
});
