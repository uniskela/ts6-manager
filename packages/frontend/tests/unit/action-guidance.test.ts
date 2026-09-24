import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DIAGNOSTIC_READ_DOES_NOT_AUTHORIZE_WRITES,
  FILE_WRITE_READ_DOES_NOT_AUTHORIZE,
  claimsWriteAuthorization,
  classifyActionPrerequisite,
  diagnosticSuccessToastMessage,
  fileBrowseErrorMessage,
  fileDeleteConfirmDescription,
  fileWriteErrorMessage,
} from '../../src/lib/action-guidance.ts';

function axiosLike(status: number, data: Record<string, unknown>) {
  return { response: { status, data }, message: 'Request failed' };
}

describe('action-guidance prerequisites', () => {
  it('classifies SSH missing, SSH failure, and permission denied', () => {
    assert.equal(
      classifyActionPrerequisite(axiosLike(400, {
        error: 'SSH credentials not configured for this server. File browsing requires SSH access because WebQuery HTTP does not support ft* commands.',
      })),
      'ssh_required',
    );
    assert.equal(
      classifyActionPrerequisite(axiosLike(502, {
        error: 'Could not connect via SSH',
        details: 'SSH handshake failed',
      })),
      'ssh_failed',
    );
    assert.equal(
      classifyActionPrerequisite(axiosLike(403, {
        error: 'Insufficient TeamSpeak permission to delete files',
        reason: 'ts_permission_denied',
        code: 2568,
      })),
      'permission_denied',
    );
    assert.equal(
      classifyActionPrerequisite(axiosLike(502, {
        error: 'TeamSpeak API Error',
        code: 2568,
        details: 'insufficient client permissions',
      })),
      'permission_denied',
    );
  });

  it('maps browse and write errors to meaningful prerequisite copy', () => {
    const browse = fileBrowseErrorMessage(axiosLike(400, {
      error: 'SSH credentials not configured for this server',
    }));
    assert.match(browse, /requires SSH/i);

    const denied = fileWriteErrorMessage(axiosLike(403, {
      reason: 'ts_permission_denied',
      code: 2568,
      error: 'Insufficient TeamSpeak permission to delete files',
      details: 'Listing this folder does not authorize writes',
    }), 'delete');
    assert.match(denied, /Listing this folder does not authorize writes/i);
    assert.equal(claimsWriteAuthorization(denied), false);

    const createDenied = fileWriteErrorMessage(axiosLike(502, {
      code: 2568,
      details: 'insufficient client permissions',
    }), 'create');
    assert.match(createDenied, /create directories/i);
    assert.match(createDenied, /does not authorize/i);
  });

  it('keeps delete confirm copy from implying browse grants write auth', () => {
    const description = fileDeleteConfirmDescription('notes.txt', '/Shared/notes.txt');
    assert.match(description, /notes\.txt/);
    assert.match(description, new RegExp(FILE_WRITE_READ_DOES_NOT_AUTHORIZE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(claimsWriteAuthorization(description), false);
    assert.equal(claimsWriteAuthorization(DIAGNOSTIC_READ_DOES_NOT_AUTHORIZE_WRITES), false);
  });
});

describe('diagnostic success never implies write authorization', () => {
  it('success toast states read-only confirmation', () => {
    const withVersion = diagnosticSuccessToastMessage('6.0.0-beta13');
    const withoutVersion = diagnosticSuccessToastMessage();
    assert.match(withVersion, /read stages OK/i);
    assert.match(withVersion, /write actions still need/i);
    assert.match(withoutVersion, /read stages succeeded/i);
    assert.equal(claimsWriteAuthorization(withVersion), false);
    assert.equal(claimsWriteAuthorization(withoutVersion), false);
    assert.equal(claimsWriteAuthorization('All stages OK — full admin write authorization granted'), true);
  });
});
