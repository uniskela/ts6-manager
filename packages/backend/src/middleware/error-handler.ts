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

/** TeamSpeak WebQuery codes that are often empty lookups / benign misses — still return 502 to the client, but do not spam error logs. */
const QUIET_TS_API_CODES = new Set([
  1281, // database empty result set
]);

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  const quietTs =
    err instanceof TSApiError && QUIET_TS_API_CODES.has(err.code);

  if (!quietTs) {
    console.error(`[Error] ${err.name}: ${err.message}`);
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
