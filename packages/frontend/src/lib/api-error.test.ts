import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isTeamSpeakLogviewIo,
  isTeamSpeakSshDisconnected,
  isTeamSpeakStarting,
  teamSpeakConnectionTitle,
  teamSpeakQueryRetry,
  teamSpeakQueryRetryDelay,
} from './api-error.ts';

function axiosLike(status: number, data: Record<string, unknown>, headers?: Record<string, string>) {
  return { response: { status, data, headers: headers ?? {} }, message: 'Request failed' };
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

describe('api-error SSH disconnect', () => {
  it('detects ts_ssh_disconnected and retries through cooldown', () => {
    const disconnected = axiosLike(503, {
      error: 'Could not browse files: SSH is not connected. Check SSH credentials and that the Query session is connected.',
      reason: 'ts_ssh_disconnected',
      retryAfterSeconds: 45,
      details: 'The EventBridge SSH session is temporarily disconnected',
    });
    assert.equal(isTeamSpeakSshDisconnected(disconnected), true);
    assert.equal(isTeamSpeakStarting(disconnected), false);
    assert.equal(teamSpeakConnectionTitle(disconnected), 'SSH reconnecting');
    assert.equal(teamSpeakQueryRetry(0, disconnected), true);
    assert.equal(teamSpeakQueryRetry(9, disconnected), true);
    assert.equal(teamSpeakQueryRetry(10, disconnected), false);
    assert.equal(teamSpeakQueryRetryDelay(0, disconnected), 45_000);
  });

  it('still recognizes legacy 502 SSH-not-connected text for retry', () => {
    const legacy = axiosLike(502, {
      error: 'Could not browse files: SSH is not connected. Check SSH credentials and that the Query session is connected.',
    });
    assert.equal(isTeamSpeakSshDisconnected(legacy), true);
    assert.equal(teamSpeakQueryRetry(0, legacy), true);
  });
});
