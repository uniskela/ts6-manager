import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: string,
  ) {
    super(message);
    this.name = 'AppError';
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
    );
    this.name = 'TeamSpeakUnavailableError';
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
    );
    this.name = 'TeamSpeakLogviewIoError';
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

/** TeamSpeak WebQuery codes that are often empty lookups / benign misses — still return 502 to the client, but do not spam error logs. */
const QUIET_TS_API_CODES = new Set([
  1281, // database empty result set
]);

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  const quietTs =
    err instanceof TSApiError && QUIET_TS_API_CODES.has(err.code);
  const quietFlood = err instanceof TeamSpeakFloodError;
  const quietUnavailable = err instanceof TeamSpeakUnavailableError;
  const quietLogviewIo = err instanceof TeamSpeakLogviewIoError;

  if (!quietTs && !quietFlood && !quietUnavailable && !quietLogviewIo) {
    console.error(`[Error] ${err.name}: ${err.message}`);
  }

  if (err instanceof TeamSpeakFloodError || err instanceof TeamSpeakUnavailableError) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
      retryAfterSeconds: err.retryAfterSeconds,
      reason: err instanceof TeamSpeakUnavailableError ? 'ts_query_starting' : 'ts_query_flood',
    });
    return;
  }

  if (err instanceof TeamSpeakLogviewIoError) {
    res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
      code: err.tsCode,
      reason: 'ts_logview_io',
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
    });
    return;
  }

  if (err instanceof TSApiError) {
    // Defensive: map bare logview I/O from any route the same way logs routes do.
    if (isTeamSpeakLogviewIoError(err)) {
      const mapped = new TeamSpeakLogviewIoError(err.code, err.message);
      res.status(mapped.statusCode).json({
        error: mapped.message,
        details: mapped.details,
        code: mapped.tsCode,
        reason: 'ts_logview_io',
      });
      return;
    }
    res.status(502).json({
      error: 'TeamSpeak API Error',
      code: err.code,
      details: err.message,
    });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}
