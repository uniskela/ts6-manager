import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isTeamSpeakLogviewIoError,
  TeamSpeakLogviewIoError,
  TSApiError,
} from './error-handler.js';

describe('isTeamSpeakLogviewIoError', () => {
  it('matches error 2052 and file I/O message', () => {
    assert.equal(isTeamSpeakLogviewIoError(new TSApiError(2052, 'file input/output error')), true);
    assert.equal(isTeamSpeakLogviewIoError(new TSApiError(0, 'file input/output error')), true);
    assert.equal(isTeamSpeakLogviewIoError(new TeamSpeakLogviewIoError()), true);
    assert.equal(isTeamSpeakLogviewIoError(new TSApiError(2568, 'insufficient client permissions')), false);
  });
});
