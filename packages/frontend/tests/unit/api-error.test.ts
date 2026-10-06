import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  apiErrorMessage,
  apiErrorPresentation,
  isTeamSpeakLogviewIo,
  isTeamSpeakSshDisconnected,
  isTeamSpeakStarting,
  teamSpeakConnectionTitle,
  teamSpeakQueryRetry,
  teamSpeakQueryRetryDelay,
} from '../../src/lib/api-error.ts';

function axiosLike(status: number, data: Record<string, unknown>, headers?: Record<string, string>) {
  return { response: { status, data, headers: headers ?? {} }, message: 'Request failed with status code ' + status };
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

describe('apiErrorPresentation', () => {
  it('uses structured duplicate-stream copy instead of Axios Request failed', () => {
    const err = axiosLike(409, {
      error: 'A video is already streaming',
      details: 'amf-test.mp4 is already playing on this bot. Stop the current stream or use Switch source.',
      reason: 'stream_already_running',
    });
    const p = apiErrorPresentation(err, 'Failed to start stream');
    assert.equal(p.title, 'A video is already streaming');
    assert.match(p.message, /amf-test\.mp4/);
    assert.equal(p.retryable, false);
    assert.equal(apiErrorMessage(err, 'Failed to start stream').includes('Request failed'), false);
  });

  it('lets a known backend reason win over generic Axios text', () => {
    const err = axiosLike(503, {
      error: 'The media sidecar is unavailable',
      details: 'Check that the sidecar is running, then try again.',
      reason: 'sidecar_unavailable',
      retryable: true,
    });
    assert.equal(apiErrorPresentation(err, 'Failed to start stream').title, 'The media sidecar is unavailable');
    assert.equal(apiErrorMessage(err, 'Failed').includes('Request failed'), false);
  });

  it('keeps Retry-After / retryable flood handling', () => {
    const flood = axiosLike(429, {
      error: 'TeamSpeak Query temporarily paused',
      details: 'flood',
      reason: 'ts_query_flood',
      retryAfterSeconds: 12,
      retryable: true,
    }, { 'retry-after': '12' });
    assert.equal(apiErrorPresentation(flood, 'Failed').retryable, true);
    assert.equal(teamSpeakQueryRetryDelay(0, flood), 12_000);
    assert.equal(teamSpeakQueryRetry(0, flood), false);
  });

  it('shows a safe fallback for unexpected 500s', () => {
    const err = axiosLike(500, {
      error: 'Something went wrong while starting the stream',
      details: 'Try again. If it keeps happening, check the server logs.',
      reason: 'unexpected_error',
      errorId: 'abc123de',
    });
    const p = apiErrorPresentation(err, 'Failed to start stream');
    assert.equal(p.title, 'Something went wrong while starting the stream');
    assert.equal(JSON.stringify(p).includes('password'), false);
    assert.match(p.message, /server logs/);
  });
});
