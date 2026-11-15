import type { Server } from 'node:http';

/**
 * Optional HTTP bind address from env.
 * Prefer LISTEN_HOST; HOST is accepted as a secondary alias when LISTEN_HOST is unset.
 * Empty / absent → undefined (Node default: all interfaces — production-compatible).
 */
export function resolveListenHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env.LISTEN_HOST ?? env.HOST ?? '').trim();
  return raw || undefined;
}

/** True when the configured host is loopback-only (IPv4 or IPv6). */
export function isLoopbackListenHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/**
 * Bind an HTTP server with an optional host.
 * Omitting host preserves historical `server.listen(port)` behaviour.
 */
export function listenHttpServer(
  server: Server,
  port: number,
  host: string | undefined,
  listeningListener?: () => void,
): Server {
  if (host) {
    return server.listen(port, host, listeningListener);
  }
  return server.listen(port, listeningListener);
}
