/**
 * Playwright-only auth seam shape. Implemented in `client.ts` when
 * `VITE_E2E_AUTH_HOOKS=true`; consumed by `tests/helpers/auth-refresh-e2e.ts`.
 */
export type E2EAuthTestHooks = {
  getMemoryTokens: () => {
    accessToken: string | null;
    refreshToken: string | null;
    authRev: number;
    sessionKey: string | null;
  };
  expireAccessInMemory: () => Promise<void>;
  /** Re-persist current in-memory auth through zustand (exercises shouldPersistAuthBlob). */
  flushPersistFromMemory: () => void;
  refreshNow: () => Promise<string | null>;
  logoutLocal: () => void;
  /** Mint a new login lineage (new sessionKey) without going through logout BC. */
  replaceSession: (
    accessToken: string,
    refreshToken: string,
    user: { id: number; username: string; displayName: string; role: 'admin' | 'viewer' },
  ) => void;
};
