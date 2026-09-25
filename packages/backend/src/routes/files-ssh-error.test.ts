import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  AppError,
  TeamSpeakSshDisconnectedError,
  TSApiError,
  errorHandler,
} from '../middleware/error-handler.js';
import { formatFatalSshFailureMessage } from '../bot-engine/ssh-query-client.js';
import { mapFileSshTransportError } from './files.routes.js';
import { isPropagatingFileSshTransportError } from './file-summary-scan.js';

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body: unknown;
  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  };
  return {
    res: res as unknown as Response,
    get statusCode() { return statusCode; },
    get body() { return body as Record<string, unknown>; },
    get headers() { return headers; },
  };
}

describe('Files SSH disconnect mapping', () => {
  it('returns 503 with ts_ssh_disconnected instead of 502 Bad Gateway', () => {
    const err = new TeamSpeakSshDisconnectedError('browse', 45);
    const mock = mockRes();
    errorHandler(err, {} as Request, mock.res, () => undefined);

    assert.equal(mock.statusCode, 503);
    assert.equal(mock.headers['retry-after'], '45');
    assert.equal(mock.body.reason, 'ts_ssh_disconnected');
    assert.match(String(mock.body.error), /SSH is not connected/i);
    assert.match(String(mock.body.details), /temporarily disconnected/i);
    assert.equal(mock.body.retryAfterSeconds, 45);
  });

  it('uses changes copy for mutations', () => {
    const err = new TeamSpeakSshDisconnectedError('changes', 15);
    const mock = mockRes();
    errorHandler(err, {} as Request, mock.res, () => undefined);

    assert.equal(mock.statusCode, 503);
    assert.match(String(mock.body.error), /Could not change files/i);
  });

  it('maps missing credentials to 400 before reconnectable disconnect', () => {
    const missing = mapFileSshTransportError(
      new Error('SSH credentials not configured for this server'),
      'browse',
      15,
    );
    assert.ok(missing instanceof AppError);
    assert.equal(missing.statusCode, 400);

    // Legacy combined wording still reconnectable (not credentials-missing).
    const legacy = mapFileSshTransportError(
      new Error('SSH not connected — check SSH credentials in server settings'),
      'browse',
      30,
    );
    assert.ok(legacy instanceof TeamSpeakSshDisconnectedError);
    assert.equal(legacy.statusCode, 503);
  });

  it('maps fatal authentication failure to non-retryable 401 (not 503)', () => {
    const mapped = mapFileSshTransportError(
      new Error(formatFatalSshFailureMessage('All configured authentication methods failed')),
      'browse',
      15,
    );
    assert.ok(mapped instanceof AppError);
    assert.ok(!(mapped instanceof TeamSpeakSshDisconnectedError));
    assert.equal(mapped.statusCode, 401);
    assert.match(mapped.message, /SSH authentication failed/i);

    const mock = mockRes();
    errorHandler(mapped, {} as Request, mock.res, () => undefined);
    assert.equal(mock.statusCode, 401);
    assert.notEqual(mock.body.reason, 'ts_ssh_disconnected');
    assert.equal(mock.headers['retry-after'], undefined);
  });

  it('maps host-key verification failure to non-retryable 401', () => {
    const mapped = mapFileSshTransportError(
      new Error(formatFatalSshFailureMessage('SSH host key mismatch for ts.example: expected abc, got def')),
      'changes',
      60,
    );
    assert.ok(mapped instanceof AppError);
    assert.ok(!(mapped instanceof TeamSpeakSshDisconnectedError));
    assert.equal(mapped.statusCode, 401);
    assert.match(mapped.message, /host key/i);
  });

  it('maps temporary disconnect to TeamSpeakSshDisconnectedError (503)', () => {
    const mapped = mapFileSshTransportError(new Error('SSH not connected'), 'browse', 45);
    assert.ok(mapped instanceof TeamSpeakSshDisconnectedError);
    assert.equal(mapped.statusCode, 503);
    assert.equal(mapped.retryAfterSeconds, 45);
  });

  it('maps TS flood 524 to TeamSpeakSshDisconnectedError', () => {
    const mapped = mapFileSshTransportError(
      new TSApiError(524, 'client is flooding'),
      'browse',
      60,
    );
    assert.ok(mapped instanceof TeamSpeakSshDisconnectedError);
    assert.equal(mapped.retryAfterSeconds, 60);
  });
});

describe('summary scan SSH transport propagation', () => {
  it('flags SSH disconnect and flood for rethrow (not unavailable)', () => {
    assert.equal(isPropagatingFileSshTransportError(new Error('SSH not connected')), true);
    assert.equal(
      isPropagatingFileSshTransportError(new Error('SSH credentials not configured for this server')),
      true,
    );
    assert.equal(
      isPropagatingFileSshTransportError(
        new Error(formatFatalSshFailureMessage('All configured authentication methods failed')),
      ),
      true,
    );
    const flood = new Error('client is flooding') as Error & { code: number };
    flood.code = 524;
    assert.equal(isPropagatingFileSshTransportError(flood), true);
    assert.equal(isPropagatingFileSshTransportError(new Error('disk full')), false);
  });
});
