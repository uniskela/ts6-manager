/**
 * Job-API client socket teardown helpers.
 * Accepted sockets must attach an `error` listener immediately — a peer
 * `destroy()` during PCM streaming (backend /stop) emits ECONNRESET and
 * crashes the fetcher if unhandled.
 */

export const EXPECTED_CLIENT_DISCONNECT_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ERR_STREAM_DESTROYED',
]);

export function isExpectedClientDisconnect(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return EXPECTED_CLIENT_DISCONNECT_CODES.has(code);
}

/**
 * Register error + close handlers once. `onTeardown` runs at most once.
 * Logs code/message only — never tokens or source URLs.
 */
export function attachClientSocketLifecycle(socket, {
  onTeardown,
  log = (line) => { process.stdout.write(`${line}\n`); },
} = {}) {
  let done = false;
  const teardown = (reason) => {
    if (done) return false;
    done = true;
    try { onTeardown?.(reason); } catch { /* caller cleanup */ }
    return true;
  };

  socket.on('error', (err) => {
    if (isExpectedClientDisconnect(err)) {
      log(`FETCHER client disconnect ${err.code}`);
    } else {
      const code = (err && err.code) || 'unknown';
      const msg = err && typeof err.message === 'string' ? err.message.slice(0, 120) : '';
      log(`FETCHER client-socket error ${code}${msg ? ` ${msg}` : ''}`);
    }
    teardown('error');
  });
  socket.on('close', () => { teardown('close'); });

  return {
    /** @returns {boolean} true the first time teardown runs */
    teardown,
    get done() { return done; },
  };
}
