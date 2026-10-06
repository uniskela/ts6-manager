import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  AppError,
  TeamSpeakFloodError,
  TeamSpeakPermissionError,
  TSApiError,
  errorHandler,
  isTeamSpeakLogviewIoError,
  isTeamSpeakPermissionError,
  mapOperationalError,
  TeamSpeakLogviewIoError,
} from './error-handler.js';
import { MediaSessionConflictError } from '../voice/media-session.js';

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

function handle(err: Error, url = '/api/music-bots/1/stream/start') {
  const mock = mockRes();
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    errorHandler(err, { originalUrl: url, url } as Request, mock.res, () => undefined);
  } finally {
    console.error = orig;
  }
  return { mock, logs };
}

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

describe('errorHandler contract', () => {
  it('keeps TeamSpeak flood status, reason and Retry-After', () => {
    const { mock } = handle(new TeamSpeakFloodError(12), '/api/logs');
    assert.equal(mock.statusCode, 429);
    assert.equal(mock.body.reason, 'ts_query_flood');
    assert.equal(mock.body.retryAfterSeconds, 12);
    assert.equal(mock.headers['retry-after'], '12');
  });

  it('keeps media_session_conflict 409 shape', () => {
    const { mock } = handle(new MediaSessionConflictError('video', [{
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'video',
      state: 'active',
      botId: 3,
      botName: 'Cinema',
      startedAt: 0,
      label: 'iptv.example',
    }]));
    assert.equal(mock.statusCode, 409);
    assert.equal(mock.body.reason, 'media_session_conflict');
    assert.ok(Array.isArray(mock.body.conflicts));
  });

  it('maps sidecar unavailability without leaking the sidecar body', () => {
    const { mock } = handle(new Error('Sidecar /source: 500 {"secret":"SIDECAR_SECRET"}'));
    assert.equal(mock.statusCode, 502);
    assert.equal(mock.body.reason, 'sidecar_unavailable');
    assert.equal(JSON.stringify(mock.body).includes('SIDECAR_SECRET'), false);
  });

  it('maps no active stream to 409', () => {
    const { mock } = handle(new Error('No active video stream'), '/api/music-bots/1/stream/volume');
    assert.equal(mock.statusCode, 409);
    assert.equal(mock.body.reason, 'stream_not_running');
  });

  it('hides unexpected secrets and logs an error id', () => {
    const { mock, logs } = handle(new Error('database password=secret'));
    assert.equal(mock.statusCode, 500);
    assert.equal(mock.body.reason, 'unexpected_error');
    assert.equal(mock.body.error, 'Something went wrong while starting the stream');
    assert.equal(JSON.stringify(mock.body).includes('password=secret'), false);
    assert.match(String(mock.body.errorId), /^[0-9a-f]{8}$/);
    assert.equal(logs.some((line) => line.includes(String(mock.body.errorId)) && line.includes('password=secret')), true);
  });
});

describe('mapOperationalError', () => {
  it('does not treat an unknown bug as operational', () => {
    assert.equal(mapOperationalError(new Error('database password=secret')), null);
  });

  it('maps bot not connected', () => {
    const mapped = mapOperationalError(new Error('Bot is not connected'));
    assert.equal(mapped?.reason, 'bot_not_connected');
    assert.equal(mapped?.statusCode, 409);
  });
});
