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

/** TeamSpeak WebQuery codes that are often empty lookups / benign misses — still return 502 to the client, but do not spam error logs. */
const QUIET_TS_API_CODES = new Set([
  1281, // database empty result set
]);

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  const quietTs =
    err instanceof TSApiError && QUIET_TS_API_CODES.has(err.code);
  const quietFlood = err instanceof TeamSpeakFloodError;

  if (!quietTs && !quietFlood) {
    console.error(`[Error] ${err.name}: ${err.message}`);
  }

  if (err instanceof TeamSpeakFloodError) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
      retryAfterSeconds: err.retryAfterSeconds,
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
    res.status(502).json({
      error: 'TeamSpeak API Error',
      code: err.code,
      details: err.message,
    });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}
