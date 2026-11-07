import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
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

type PersistedAuthBlob = {
  state?: {
    accessToken?: string | null;
    refreshToken?: string | null;
    user?: UserInfo | null;
  };
};

function accessExp(token: string | null | undefined): number | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Refuse to let a stale tab rewrite `ts6-auth` over a peer rotation.
 * When refresh tokens differ, keep the blob whose access JWT has the newer `exp`.
 */
export function shouldPersistAuthBlob(existingRaw: string | null, incomingRaw: string): boolean {
  if (!existingRaw) return true;
  try {
    const existing = JSON.parse(existingRaw) as PersistedAuthBlob;
    const incoming = JSON.parse(incomingRaw) as PersistedAuthBlob;
    const exRef = existing.state?.refreshToken;
    const inRef = incoming.state?.refreshToken;
    if (!exRef || !inRef || exRef === inRef) return true;
    // Clear/logout always wins.
    if (!incoming.state?.accessToken && !inRef) return true;
    if (!incoming.state?.accessToken) return true;
    const exExp = accessExp(existing.state?.accessToken ?? null);
    const inExp = accessExp(incoming.state?.accessToken ?? null);
    if (exExp == null || inExp == null) return true;
    return inExp >= exExp;
  } catch {
    return true;
  }
}

const authStorage = createJSONStorage(() => {
  const base = localStorage;
  return {
    getItem: (name) => base.getItem(name),
    setItem: (name, value) => {
      if (name === 'ts6-auth' && !shouldPersistAuthBlob(base.getItem(name), value)) {
        return;
      }
      base.setItem(name, value);
    },
    removeItem: (name) => base.removeItem(name),
  };
});

// M9: Tokens stored in localStorage. This is an accepted tradeoff — no XSS vectors
// exist in the frontend (no dangerouslySetInnerHTML, no eval). If XSS is introduced,
// consider moving to httpOnly cookies or in-memory storage.
export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setAuth: (accessToken, refreshToken, user) => {
        const previousRefreshToken = get().refreshToken;
        set({ accessToken, refreshToken, user });
        // New login/session — drop cross-tab refresh cache so a prior account's
        // tokens cannot be adopted. Same-account refresh uses setTokens only.
        try {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('ts6-auth-session', {
              detail: { previousRefreshToken },
            }));
          }
        } catch {
          // Coordination is best-effort; login must still complete.
        }
      },
      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken }),
      setUser: (user) => set({ user }),
      logout: () => {
        // Clear auth first so a localStorage throw while persisting
        // ts6-server cannot leave the session active.
        set({ accessToken: null, refreshToken: null, user: null });
        // Peer-tab logout sync (BroadcastChannel) is wired from the API client
        // via this event — keeps the store free of api/ imports.
        try {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event('ts6-auth-logout'));
          }
        } catch {
          // Coordination is best-effort; local logout must still complete.
        }
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
    { name: 'ts6-auth', storage: authStorage },
  ),
);
