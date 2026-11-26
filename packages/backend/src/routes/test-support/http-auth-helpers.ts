/**
 * Shared HTTP helpers for P1-A admin revoke suites (mock + SQLite).
 * Test-only — not imported by production routes.
 */
import assert from 'node:assert/strict';

/** PUT /api/users/2 with a JSON body (victim user in both revoke suites). */
export async function putUser(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/users/2`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Assert POST /api/auth/refresh rejects the given opaque refresh token. */
export async function assertRefreshRejected(base: string, refreshToken: string) {
  const refresh = await fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  assert.equal(refresh.status, 401);
}
