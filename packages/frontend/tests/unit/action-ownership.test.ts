import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFilePath,
  canConfirmFileAction,
  connectionDraftKey,
  mergeClearedInstanceFields,
  sameFileActionTarget,
  shouldApplyConnectionTestResult,
  shouldApplyJournalToggleResult,
  shouldClearInstanceDraft,
  shouldCloseFileDialog,
  type FileActionTarget,
} from '../../src/lib/action-ownership.ts';

const targetA: FileActionTarget = {
  configId: 1,
  sid: 1,
  cid: 10,
  fullPath: '/clip.wav',
  ownerGeneration: 3,
  entryName: 'clip.wav',
};

const targetB: FileActionTarget = {
  configId: 2,
  sid: 1,
  cid: 10,
  fullPath: '/clip.wav',
  ownerGeneration: 3,
  entryName: 'clip.wav',
};

describe('file action ownership (scenarios 1–2)', () => {
  it('builds the path captured when Delete opens', () => {
    assert.equal(buildFilePath('/', 'clip.wav'), '/clip.wav');
    assert.equal(buildFilePath('/folder', 'clip.wav'), '/folder/clip.wav');
  });

  it('refuses confirm after switching to connection B (no request to B)', () => {
    assert.equal(
      canConfirmFileAction(targetA, { configId: 1, sid: 1, cid: 10 }),
      true,
    );
    assert.equal(
      canConfirmFileAction(targetA, { configId: 2, sid: 1, cid: 10 }),
      false,
    );
    assert.equal(sameFileActionTarget(targetA, targetB), false);
  });

  it('invalidates A without closing a newly opened dialog for B', () => {
    assert.equal(shouldCloseFileDialog(targetA, targetA), true);
    assert.equal(shouldCloseFileDialog(targetB, targetA), false);
    assert.equal(shouldCloseFileDialog(null, targetA), false);
  });
});

describe('instance draft ownership', () => {
  it('clears draft only for the submitted connection generation', () => {
    assert.equal(shouldClearInstanceDraft(1, 1, 4, 4), true);
    assert.equal(shouldClearInstanceDraft(2, 1, 4, 4), false);
    assert.equal(shouldClearInstanceDraft(1, 1, 5, 4), false);
  });

  it('keeps newer edits when clearing submitted keys', () => {
    const merged = mergeClearedInstanceFields(
      {
        serverinstance_filetransfer_port: '30033',
        serverinstance_serverquery_flood_time: '99',
      },
      ['serverinstance_filetransfer_port'],
    );
    assert.deepEqual(merged, { serverinstance_serverquery_flood_time: '99' });
  });
});

describe('journal toggle ownership', () => {
  it('resets local UI only when the live pair still matches the submission', () => {
    assert.equal(
      shouldApplyJournalToggleResult(
        { configId: 1, sid: 2, ownerGeneration: 7 },
        { configId: 1, sid: 2, ownerGeneration: 7 },
      ),
      true,
    );
    assert.equal(
      shouldApplyJournalToggleResult(
        { configId: 9, sid: 2, ownerGeneration: 7 },
        { configId: 1, sid: 2, ownerGeneration: 7 },
      ),
      false,
    );
  });
});

describe('connection-test generation guards (scenario 3)', () => {
  it('fingerprints credentials used for the probe', () => {
    const key = connectionDraftKey({
      host: 'ts.example',
      webqueryPort: '10080',
      apiKey: 'secret',
      useHttps: false,
      sshPort: '10022',
      sshUsername: 'serveradmin',
      sshPassword: 'pw',
    });
    const edited = connectionDraftKey({
      host: 'ts.example',
      webqueryPort: '10080',
      apiKey: 'other',
      useHttps: false,
      sshPort: '10022',
      sshUsername: 'serveradmin',
      sshPassword: 'pw',
    });
    assert.notEqual(key, edited);
  });

  it('leaves an edited draft untested when an obsolete request succeeds', () => {
    const submitted = {
      ownerGeneration: 1,
      draftKey: connectionDraftKey({
        host: 'a',
        webqueryPort: '10080',
        apiKey: 'old',
        useHttps: false,
        sshPort: '10022',
        sshUsername: 'u',
        sshPassword: 'p',
      }),
    };
    const liveAfterEdit = {
      ownerGeneration: 2,
      draftKey: connectionDraftKey({
        host: 'a',
        webqueryPort: '10080',
        apiKey: 'new',
        useHttps: false,
        sshPort: '10022',
        sshUsername: 'u',
        sshPassword: 'p',
      }),
    };
    assert.equal(shouldApplyConnectionTestResult(liveAfterEdit, submitted), false);
    assert.equal(shouldApplyConnectionTestResult(submitted, submitted), true);
  });
});
