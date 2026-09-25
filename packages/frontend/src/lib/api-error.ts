export function apiErrorMessage(error: unknown, fallback: string): string {
  const err = error as any;
  const data = err?.response?.data;
  if (data?.error && data?.details) return `${data.error}. ${data.details}`;
  if (data?.details) return String(data.details);
  if (data?.error) return String(data.error);
  if (err?.message) return String(err.message);
  return fallback;
}

/** TeamSpeak `logview` could not open/read its logfile (error 2052 / file I/O). */
export function isTeamSpeakLogviewIo(error: unknown): boolean {
  const err = error as any;
  const data = err?.response?.data;
  if (data?.reason === 'ts_logview_io') return true;
  if (Number(data?.code) === 2052) return true;

  const text = `${data?.error || ''} ${data?.details || ''} ${err?.message || ''}`.toLowerCase();
  return text.includes('file input/output error') || text.includes('log file unavailable');
}

/** TeamSpeak Query still booting / resetting sockets (gated 503, or transport hang-ups). */
export function isTeamSpeakStarting(error: unknown): boolean {
  if (isTeamSpeakLogviewIo(error)) return false;
  if (isTeamSpeakSshDisconnected(error)) return false;

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

/** EventBridge SSH session temporarily down (often Query flood cooldown after redeploy). */
export function isTeamSpeakSshDisconnected(error: unknown): boolean {
  const err = error as any;
  const reason = err?.response?.data?.reason;
  if (reason === 'ts_ssh_disconnected') return true;

  const status = err?.response?.status;
  const text = `${err?.response?.data?.error || ''} ${err?.response?.data?.details || ''} ${err?.message || ''}`.toLowerCase();
  if (status === 503 || status === 502) {
    return text.includes('ssh is not connected') || text.includes('ssh not connected');
  }
  return false;
}

export function teamSpeakConnectionTitle(error: unknown, failedTitle = 'Connection failed'): string {
  if (isTeamSpeakLogviewIo(error)) return 'TeamSpeak log file unavailable';
  if (isTeamSpeakSshDisconnected(error)) return 'SSH reconnecting';
  return isTeamSpeakStarting(error) ? 'TeamSpeak is still starting' : failedTitle;
}

export function teamSpeakRefreshTone(error: unknown | null | undefined): 'live' | 'degraded' | 'starting' {
  if (!error) return 'live';
  if (isTeamSpeakStarting(error) || isTeamSpeakSshDisconnected(error)) return 'starting';
  return 'degraded';
}

/**
 * Retry Query-backed pages through flood cooldowns and cold-start transport failures.
 * Flood (429): do not stampede. Starting / SSH reconnect only: keep trying a bit longer.
 * Logview I/O (2052): never auto-retry — hammering TeamSpeak can worsen file locks.
 * Ordinary 503 (e.g. refresh-failure fixtures) use the short retry budget.
 */
export function teamSpeakQueryRetry(failureCount: number, error: unknown): boolean {
  if (isTeamSpeakLogviewIo(error)) return false;
  const status = (error as any)?.response?.status;
  if (status === 429) return false;
  if (isTeamSpeakStarting(error) || isTeamSpeakSshDisconnected(error)) return failureCount < 10;
  return failureCount < 3;
}

export function teamSpeakQueryRetryDelay(attempt: number, error: unknown): number {
  if (isTeamSpeakLogviewIo(error)) return 0;

  const retryAfterHeader = Number((error as any)?.response?.headers?.['retry-after']);
  const retryAfterBody = Number((error as any)?.response?.data?.retryAfterSeconds);
  const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
    ? retryAfterHeader
    : (Number.isFinite(retryAfterBody) && retryAfterBody > 0 ? retryAfterBody : 0);
  if (retryAfter > 0) return Math.min(60_000, retryAfter * 1000);

  if (isTeamSpeakStarting(error) || isTeamSpeakSshDisconnected(error)) {
    return Math.min(8_000, 1_000 * 2 ** attempt);
  }
  return Math.min(1_500, 300 * 2 ** attempt);
}
