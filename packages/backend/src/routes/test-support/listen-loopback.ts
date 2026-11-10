/**
 * Shared Express loopback listener for auth refresh mock suites.
 * Test-only — each call starts an isolated server on 127.0.0.1:0.
 */
import type { Express } from 'express';

export function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('expected TCP address'));
      else {
        resolve({
          base: `http://127.0.0.1:${address.port}`,
          close: () =>
            new Promise((res, rej) => {
              server.closeAllConnections?.();
              server.close((err) => (err ? rej(err) : res()));
            }),
        });
      }
    });
  });
}
