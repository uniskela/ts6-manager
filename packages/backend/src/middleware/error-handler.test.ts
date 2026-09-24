import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isTeamSpeakLogviewIoError,
  isTeamSpeakPermissionError,
  TeamSpeakLogviewIoError,
  TeamSpeakPermissionError,
  TSApiError,
} from './error-handler.js';

describe('isTeamSpeakLogviewIoError', () => {
  it('matches error 2052 and file I/O message', () => {
    assert.equal(isTeamSpeakLogviewIoError(new TSApiError(2052, 'file input/output error')), true);
    assert.equal(isTeamSpeakLogviewIoError(new TSApiError(0, 'file input/output error')), true);
    assert.equal(isTeamSpeakLogviewIoError(new TeamSpeakLogviewIoError()), true);
    assert.equal(isTeamSpeakPermissionError(new TSApiError(2568, 'insufficient client permissions')), true);
    assert.equal(isTeamSpeakLogviewIoError(new TSApiError(2568, 'insufficient client permissions')), false);
  });
});

describe('TeamSpeakPermissionError', () => {
  it('matches error 2568 and states read success does not authorize writes', () => {
    assert.equal(isTeamSpeakPermissionError(new TSApiError(2568, 'insufficient client permissions')), true);
    assert.equal(
      isTeamSpeakPermissionError(new TeamSpeakPermissionError(2568, 'insufficient client permissions', 'deleting files')),
      true,
    );
    assert.equal(isTeamSpeakPermissionError(new TSApiError(2052, 'file input/output error')), false);

    const mapped = new TeamSpeakPermissionError(2568, 'insufficient client permissions', 'deleting files');
    assert.equal(mapped.statusCode, 403);
    assert.match(mapped.message, /deleting files/i);
    assert.match(mapped.details || '', /do not authorize writes/i);
  });
});
