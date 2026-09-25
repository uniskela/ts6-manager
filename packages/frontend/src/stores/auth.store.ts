import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useServerStore } from './server.store';

interface UserInfo {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'viewer';
}

interface AuthStore {
  accessToken: string | null;
  refreshToken: string | null;
  user: UserInfo | null;
  setAuth: (accessToken: string, refreshToken: string, user: UserInfo) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  setUser: (user: UserInfo) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
  isAdmin: () => boolean;
  canWrite: () => boolean;
}

// M9: Tokens stored in localStorage. This is an accepted tradeoff — no XSS vectors
// exist in the frontend (no dangerouslySetInnerHTML, no eval). If XSS is introduced,
// consider moving to httpOnly cookies or in-memory storage.
export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setAuth: (accessToken, refreshToken, user) =>
        set({ accessToken, refreshToken, user }),
      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken }),
      setUser: (user) => set({ user }),
      logout: () => {
        // Clear auth first so a localStorage throw while persisting
        // ts6-server cannot leave the session active.
        set({ accessToken: null, refreshToken: null, user: null });
        // Drop persisted connection selection with the session. Leaving
        // selectedConfigId/selectedSid in ts6-server after logout can strand
        // Dashboard on an indefinite PageLoader when /api/servers never loads
        // (selection set, context never validates, no gateError).
        // Swallow persist failures so callers (navigate / refresh) still run.
        try {
          useServerStore.getState().clearServer();
        } catch {
          // clearServer may have updated memory before setItem threw, leaving
          // a stale ts6-server key. Best-effort remove so reload cannot restore it.
          try {
            useServerStore.persist.clearStorage();
          } catch {
            // Auth is already cleared; do not block logout on storage cleanup.
          }
        }
      },
      isAuthenticated: () => !!get().accessToken,
      isAdmin: () => get().user?.role === 'admin',
      canWrite: () => get().user?.role === 'admin',
    }),
    { name: 'ts6-auth' },
  ),
);
