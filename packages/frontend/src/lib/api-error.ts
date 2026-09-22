export function apiErrorMessage(error: unknown, fallback: string): string {
  const err = error as any;
  const data = err?.response?.data;
  if (data?.error && data?.details) return `${data.error}. ${data.details}`;
  if (data?.details) return String(data.details);
  if (data?.error) return String(data.error);
  if (err?.message) return String(err.message);
  return fallback;
}

/** TeamSpeak Query still booting / resetting sockets (HTTP 503, or transport 502 while warming). */
export function isTeamSpeakStarting(error: unknown): boolean {
  const err = error as any;
  const status = err?.response?.status;
  const reason = err?.response?.data?.reason;
  if (status === 503 && reason === 'ts_query_starting') return true;
  const text = `${err?.response?.data?.error || ''} ${err?.response?.data?.details || ''} ${err?.message || ''}`.toLowerCase();
  if (status === 503) {
    return text.includes('still starting') || text.includes('not ready') || text.includes('unavailable');
  }
  // Unmapped hang-ups still arrive as 502 until the backend upgrades them to 503.
  if (status === 502 || status === 503) {
    return (
      text.includes('socket hang up')
      || text.includes('econnreset')
      || text.includes('econnrefused')
      || text.includes('etimedout')
      || text.includes('still starting')
      || text.includes('not ready')
      || text.includes('connection lost before handshake')
    );
  }
  return false;
}

export function teamSpeakConnectionTitle(error: unknown, failedTitle = 'Connection failed'): string {
  return isTeamSpeakStarting(error) ? 'TeamSpeak is still starting' : failedTitle;
}

export function teamSpeakRefreshTone(error: unknown | null | undefined): 'live' | 'degraded' | 'starting' {
  if (!error) return 'live';
  return isTeamSpeakStarting(error) ? 'starting' : 'degraded';
}

/**
 * Retry Query-backed pages through flood cooldowns and cold-start 503s.
 * Flood (429): do not stampede. Starting (503/hang-up): keep trying a bit longer.
 */
export function teamSpeakQueryRetry(failureCount: number, error: unknown): boolean {
  const status = (error as any)?.response?.status;
  if (status === 429) return false;
  if (status === 503 || isTeamSpeakStarting(error)) return failureCount < 10;
  return failureCount < 3;
}

export function teamSpeakQueryRetryDelay(attempt: number, error: unknown): number {
  const retryAfterHeader = Number((error as any)?.response?.headers?.['retry-after']);
  const retryAfterBody = Number((error as any)?.response?.data?.retryAfterSeconds);
  const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
    ? retryAfterHeader
    : (Number.isFinite(retryAfterBody) && retryAfterBody > 0 ? retryAfterBody : 0);
  if (retryAfter > 0) return Math.min(30_000, retryAfter * 1000);

  if (isTeamSpeakStarting(error) || (error as any)?.response?.status === 503) {
    return Math.min(8_000, 1_000 * 2 ** attempt);
  }
  return Math.min(1_500, 300 * 2 ** attempt);
}
