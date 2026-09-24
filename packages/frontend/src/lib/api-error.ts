export function apiErrorMessage(error: unknown, fallback: string): string {
  const err = error as any;
  const data = err?.response?.data;
  if (data?.error && data?.details) return `${data.error}. ${data.details}`;
  if (data?.details) return String(data.details);
  if (data?.error) return String(data.error);
  if (err?.message) return String(err.message);
  return fallback;
}

/** TeamSpeak Query still booting / resetting sockets (gated 503, or transport hang-ups). */
export function isTeamSpeakStarting(error: unknown): boolean {
  const err = error as any;
  const status = err?.response?.status;
  const reason = err?.response?.data?.reason;
  if (status === 503 && reason === 'ts_query_starting') return true;

  const text = `${err?.response?.data?.error || ''} ${err?.response?.data?.details || ''} ${err?.message || ''}`.toLowerCase();

  // Explicit warming copy from TeamSpeakUnavailableError — not every generic 503.
  if (text.includes('query is still starting') || text.includes('still coming up')) return true;

  // Unmapped hang-ups / resets while Query boots (often still HTTP 502).
  if (status === 502 || status === 503) {
    return (
      text.includes('socket hang up')
      || text.includes('econnreset')
      || text.includes('econnrefused')
      || text.includes('etimedout')
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
 * Retry Query-backed pages through flood cooldowns and cold-start transport failures.
 * Flood (429): do not stampede. Starting only: keep trying a bit longer.
 * Ordinary 503 (e.g. refresh-failure fixtures) use the short retry budget.
 */
export function teamSpeakQueryRetry(failureCount: number, error: unknown): boolean {
  const status = (error as any)?.response?.status;
  if (status === 429) return false;
  if (isTeamSpeakStarting(error)) return failureCount < 10;
  return failureCount < 3;
}

export function teamSpeakQueryRetryDelay(attempt: number, error: unknown): number {
  const retryAfterHeader = Number((error as any)?.response?.headers?.['retry-after']);
  const retryAfterBody = Number((error as any)?.response?.data?.retryAfterSeconds);
  const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
    ? retryAfterHeader
    : (Number.isFinite(retryAfterBody) && retryAfterBody > 0 ? retryAfterBody : 0);
  if (retryAfter > 0) return Math.min(30_000, retryAfter * 1000);

  if (isTeamSpeakStarting(error)) {
    return Math.min(8_000, 1_000 * 2 ** attempt);
  }
  return Math.min(1_500, 300 * 2 ** attempt);
}
