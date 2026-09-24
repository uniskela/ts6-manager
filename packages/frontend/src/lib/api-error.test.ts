import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isTeamSpeakLogviewIo,
  isTeamSpeakStarting,
  teamSpeakConnectionTitle,
  teamSpeakQueryRetry,
} from './api-error.ts';

function axiosLike(status: number, data: Record<string, unknown>) {
  return { response: { status, data }, message: 'Request failed' };
}

describe('api-error logview I/O', () => {
  it('detects ts_logview_io reason and 2052 code', () => {
    const byReason = axiosLike(502, {
      error: 'TeamSpeak log file unavailable',
      details: 'TeamSpeak could not read the server logfile',
      reason: 'ts_logview_io',
      code: 2052,
    });
    assert.equal(isTeamSpeakLogviewIo(byReason), true);
    assert.equal(isTeamSpeakStarting(byReason), false);
    assert.equal(teamSpeakConnectionTitle(byReason), 'TeamSpeak log file unavailable');
    assert.equal(teamSpeakQueryRetry(0, byReason), false);
    assert.equal(teamSpeakQueryRetry(1, byReason), false);

    const byCode = axiosLike(502, {
      error: 'TeamSpeak API Error',
      details: 'file input/output error',
      code: 2052,
    });
    assert.equal(isTeamSpeakLogviewIo(byCode), true);
    assert.equal(teamSpeakQueryRetry(0, byCode), false);
  });

  it('does not treat ordinary 502 transport failures as logview I/O', () => {
    const hangup = axiosLike(502, {
      error: 'TeamSpeak API Error',
      details: 'socket hang up',
    });
    assert.equal(isTeamSpeakLogviewIo(hangup), false);
    assert.equal(isTeamSpeakStarting(hangup), true);
    assert.equal(teamSpeakQueryRetry(0, hangup), true);
  });
});
