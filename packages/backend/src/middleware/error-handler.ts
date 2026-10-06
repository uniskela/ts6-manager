import { randomBytes } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

export type AppErrorMeta = {
  reason?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
};

export class AppError extends Error {
  reason?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;

  constructor(
    public statusCode: number,
    message: string,
    public details?: string,
    meta?: AppErrorMeta,
  ) {
    super(message);
    this.name = 'AppError';
    this.reason = meta?.reason;
    this.retryable = meta?.retryable;
    this.retryAfterSeconds = meta?.retryAfterSeconds;
  }
}

export class TSApiError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'TSApiError';
  }
}

export class TeamSpeakFloodError extends AppError {
  constructor(public retryAfterSeconds: number) {
    super(
      429,
      'TeamSpeak Query temporarily paused',
      `TeamSpeak flood protection is active. TS6 Manager will retry automatically after the cooldown (about ${retryAfterSeconds}s). If this repeats, verify the TS6 Manager host/IP is present in the TeamSpeak Query allow-list.`,
      { reason: 'ts_query_flood', retryable: true, retryAfterSeconds },
    );
    this.name = 'TeamSpeakFloodError';
  }
}

/** Query port open but TeamSpeak still booting / resetting sockets (common right after compose up). */
export class TeamSpeakUnavailableError extends AppError {
  constructor(public retryAfterSeconds: number = 5) {
    super(
      503,
      'TeamSpeak Query is still starting',
      `The TeamSpeak server is up but Query is not ready yet (common for ~30–90s after a fresh compose start). Wait a few seconds and retry — about ${retryAfterSeconds}s is usually enough.`,
      { reason: 'ts_query_starting', retryable: true, retryAfterSeconds },
    );
    this.name = 'TeamSpeakUnavailableError';
  }
}

/**
 * EventBridge SSH session is down (often Query flood cooldown right after redeploy).
 * Not a Bad Gateway — credentials may be fine; reconnect is expected.
 */
export class TeamSpeakSshDisconnectedError extends AppError {
  constructor(
    purpose: 'browse' | 'changes' = 'browse',
    public retryAfterSeconds: number = 15,
  ) {
    super(
      503,
      purpose === 'browse'
        ? 'Could not browse files: SSH is not connected. Check SSH credentials and that the Query session is connected.'
        : 'Could not change files: SSH is not connected. Check SSH credentials and that the Query session is connected.',
      `The EventBridge SSH session is temporarily disconnected (common for ~60s after TeamSpeak Query flood protection on container start). Wait about ${retryAfterSeconds}s and retry.`,
      { reason: 'ts_ssh_disconnected', retryable: true, retryAfterSeconds },
    );
    this.name = 'TeamSpeakSshDisconnectedError';
  }
}

/**
 * TeamSpeak `logview` could not read its logfile (commonly error 2052).
 * This is a TeamSpeak host/filesystem issue (permissions, lock, rotation), not a Manager transport failure.
 */
export class TeamSpeakLogviewIoError extends AppError {
  constructor(public tsCode: number = 2052, tsMessage = 'file input/output error') {
    super(
      502,
      'TeamSpeak log file unavailable',
      `TeamSpeak could not read the server logfile (error ${tsCode}: ${tsMessage}). `
        + 'This is usually a log directory permission, lock, or rotation issue on the TeamSpeak host — not a Manager connection failure. '
        + 'Retry once after a few seconds, or check the TeamSpeak logs volume/permissions (see docs/troubleshooting.md).',
      { reason: 'ts_logview_io' },
    );
    this.name = 'TeamSpeakLogviewIoError';
  }
}

/**
 * TeamSpeak Query permission denied (commonly error 2568).
 * Read/list success elsewhere never implies authorization for this write (or a different read scope).
 */
export class TeamSpeakPermissionError extends AppError {
  constructor(
    public tsCode: number = 2568,
    tsMessage = 'insufficient client permissions',
    actionHint = 'this action',
  ) {
    super(
      403,
      `Insufficient TeamSpeak permission for ${actionHint}`,
      `TeamSpeak denied the request (error ${tsCode}: ${tsMessage}). `
        + 'Successful reads or connection diagnostics do not authorize writes — grant the Query identity the permissions required for this action.',
      { reason: 'ts_permission_denied' },
    );
    this.name = 'TeamSpeakPermissionError';
  }
}

/** True when TeamSpeak reports logfile I/O failure from `logview` (error 2052 / matching message). */
export function isTeamSpeakLogviewIoError(error: unknown): boolean {
  if (error instanceof TeamSpeakLogviewIoError) return true;
  if (error instanceof TSApiError) {
    if (error.code === 2052) return true;
    return /file\s+input\/output\s+error/i.test(error.message);
  }
  return false;
}

export function isTeamSpeakPermissionError(error: unknown): boolean {
  if (error instanceof TeamSpeakPermissionError) return true;
  if (error instanceof TSApiError) {
    if (error.code === 2568) return true;
    return /insufficient\s+(client\s+)?permissions?/i.test(error.message);
  }
  return false;
}

/** Map known operational Error messages so they do not become generic 500s. */
export function mapOperationalError(err: Error): AppError | null {
  const msg = err.message;

  if (msg === 'Bot is not connected') {
    return new AppError(409, 'Bot is not connected', 'Start the bot, then try again.', {
      reason: 'bot_not_connected',
      retryable: true,
    });
  }
  if (msg === 'Bot is already running') {
    return new AppError(409, 'This bot is already started', undefined, { reason: 'bot_already_started' });
  }
  if (msg === 'Video stream already active') {
    return new AppError(
      409,
      'A video is already streaming',
      'Stop the current stream or use Switch source to change the video without stopping it.',
      { reason: 'stream_already_running' },
    );
  }
  if (msg === 'No active video stream') {
    return new AppError(409, 'No active stream', 'Start a video first.', { reason: 'stream_not_running' });
  }
  if (msg === 'Local video file not found') {
    return new AppError(404, 'Local video file not found', 'Choose a file that exists in the music folder.', {
      reason: 'source_not_found',
    });
  }
  if (
    msg === 'Invalid local video path'
    || msg === 'Local video path must be a filename under MUSIC_DIR'
    || msg === 'Local video path must be under MUSIC_DIR'
  ) {
    return new AppError(400, 'Local video source must be a filename under the music directory', undefined, {
      reason: 'source_invalid',
    });
  }
  if (msg === 'volume must be a number') {
    return new AppError(400, 'volume must be a number from 0 to 100');
  }
  if (msg === 'Sidecar health check timeout' || msg === 'No sidecar') {
    const timeout = msg.includes('timeout');
    return new AppError(
      timeout ? 504 : 503,
      timeout ? 'The media sidecar timed out' : 'The media sidecar is unavailable',
      'Check that the sidecar is running, then try again.',
      { reason: timeout ? 'sidecar_timeout' : 'sidecar_unavailable', retryable: true },
    );
  }
  if (msg.startsWith('Sidecar ')) {
    return new AppError(
      502,
      'The media sidecar is unavailable',
      'Check that the sidecar is running, then try again.',
      { reason: 'sidecar_unavailable', retryable: true },
    );
  }
  if (msg.startsWith('Failed to start sidecar:')) {
    const timeout = /timeout|abort/i.test(msg) || err.name === 'TimeoutError' || err.name === 'AbortError';
    return new AppError(
      timeout ? 504 : 502,
      timeout ? 'The media sidecar timed out' : 'The media sidecar is unavailable',
      'Check that the sidecar is running, then try again.',
      { reason: timeout ? 'sidecar_timeout' : 'sidecar_unavailable', retryable: true },
    );
  }
  if (msg.startsWith('yt-dlp not found:') || msg.startsWith('yt-dlp failed to start:')) {
    return new AppError(502, 'Could not start yt-dlp', 'Check that yt-dlp is installed, then try again.', {
      reason: 'source_unavailable',
    });
  }
  if (msg.startsWith('TeamSpeak did not answer the stream request')) {
    return new AppError(
      504,
      'TeamSpeak did not answer the stream request',
      'Try again. If it keeps happening, check that the bot is connected and the server allows streaming.',
      { reason: 'ts_stream_timeout', retryable: true },
    );
  }
  if (msg.startsWith('TeamSpeak refused the stream:')) {
    return new AppError(502, 'TeamSpeak refused the stream', msg.replace(/^TeamSpeak refused the stream:\s*/, ''), {
      reason: 'ts_stream_refused',
    });
  }
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return new AppError(504, 'The request timed out', 'Try again.', {
      reason: 'request_timeout',
      retryable: true,
    });
  }

  return null;
}

const QUIET_TS_API_CODES = new Set([
  1281, // database empty result set
]);

function appErrorBody(err: AppError): Record<string, unknown> {
  const body: Record<string, unknown> = { error: err.message };
  if (err.details) body.details = err.details;
  if (err.reason) body.reason = err.reason;
  if (typeof err.retryable === 'boolean') body.retryable = err.retryable;
  if (err.retryAfterSeconds != null) body.retryAfterSeconds = err.retryAfterSeconds;
  return body;
}

function sendAppError(res: Response, err: AppError): void {
  if (err.retryAfterSeconds != null) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds));
  }

  if (err instanceof TeamSpeakLogviewIoError) {
    res.status(err.statusCode).json({ ...appErrorBody(err), code: err.tsCode });
    return;
  }
  if (err instanceof TeamSpeakPermissionError) {
    res.status(err.statusCode).json({ ...appErrorBody(err), code: err.tsCode });
    return;
  }
  const conflict = err as AppError & { requested?: unknown; conflicts?: unknown };
  if (err.name === 'MediaSessionConflictError') {
    res.status(err.statusCode).json({
      ...appErrorBody(err),
      requested: conflict.requested,
      conflicts: conflict.conflicts,
    });
    return;
  }
  res.status(err.statusCode).json(appErrorBody(err));
}

function unexpectedClientCopy(req: Request): { error: string; details: string } {
  const path = `${req.originalUrl || req.url || ''}`;
  if (/\/stream\/start(?:\?|$)/.test(path) || /\/iptv\/stream(?:\?|$)/.test(path)) {
    return {
      error: 'Something went wrong while starting the stream',
      details: 'Try again. If it keeps happening, check the server logs.',
    };
  }
  return {
    error: 'Something went wrong',
    details: 'Try again. If it keeps happening, check the server logs.',
  };
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const mapped = err instanceof AppError ? err : mapOperationalError(err);

  const quietTs = err instanceof TSApiError && QUIET_TS_API_CODES.has(err.code);
  const quietMapped = mapped instanceof AppError && (
    mapped.statusCode < 500
    || mapped instanceof TeamSpeakFloodError
    || mapped instanceof TeamSpeakUnavailableError
    || mapped instanceof TeamSpeakSshDisconnectedError
    || mapped instanceof TeamSpeakLogviewIoError
    || mapped instanceof TeamSpeakPermissionError
    || mapped.name === 'MediaSessionConflictError'
  );

  if (mapped) {
    if (!quietMapped) {
      console.error(`[Error] ${mapped.name}: ${mapped.message}`);
    }
    sendAppError(res, mapped);
    return;
  }

  if (err instanceof TSApiError) {
    if (isTeamSpeakLogviewIoError(err)) {
      sendAppError(res, new TeamSpeakLogviewIoError(err.code, err.message));
      return;
    }
    if (isTeamSpeakPermissionError(err)) {
      sendAppError(res, new TeamSpeakPermissionError(err.code, err.message));
      return;
    }
    if (!quietTs) {
      console.error(`[Error] ${err.name}: ${err.message}`);
    }
    res.status(502).json({
      error: 'TeamSpeak API Error',
      code: err.code,
      details: err.message,
    });
    return;
  }

  const errorId = randomBytes(4).toString('hex');
  console.error(`[Error ${errorId}] ${err.name}: ${err.message}`);
  const copy = unexpectedClientCopy(req);
  res.status(500).json({
    error: copy.error,
    details: copy.details,
    reason: 'unexpected_error',
    errorId,
  });
}
