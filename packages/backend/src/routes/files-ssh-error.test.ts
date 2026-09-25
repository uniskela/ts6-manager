import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  TeamSpeakSshDisconnectedError,
  errorHandler,
} from '../middleware/error-handler.js';

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
});
