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
  /**
   * Monotonic session revision persisted with tokens. Bumped on login,
   * refresh-token rotation, and logout so a stale tab cannot rewrite
   * `ts6-auth` over a peer advance. Not derived from JWT `exp`.
   */
  authRev: number;
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
    authRev?: number;
  };
};

function blobRev(blob: PersistedAuthBlob): number {
  const rev = blob.state?.authRev;
  return typeof rev === 'number' && Number.isFinite(rev) ? rev : 0;
}

function isClearedAuth(blob: PersistedAuthBlob): boolean {
  return !blob.state?.accessToken && !blob.state?.refreshToken;
}

/**
 * Refuse to let a stale tab rewrite `ts6-auth` over a newer session revision.
 * Ordering uses persisted `authRev` (bumped on login / refresh rotation /
 * logout) — never JWT `exp`, which can tie across rotations or lag a new login.
 *
 * authRev is per-tab until each bump reads max(memory, persist); it is not a
 * globally synchronized clock. Equal-rev different-refresh ties keep the
 * existing blob (first persist wins) — rare when bumps observe persist.
 */
export function shouldPersistAuthBlob(existingRaw: string | null, incomingRaw: string): boolean {
  if (!existingRaw) return true;
  try {
    const existing = JSON.parse(existingRaw) as PersistedAuthBlob;
    const incoming = JSON.parse(incomingRaw) as PersistedAuthBlob;
    const exRev = blobRev(existing);
    const inRev = blobRev(incoming);

    // Logout / clear over a live session must strictly exceed persist rev so a
    // tab one step behind a peer rotation (memory N → tombstone N+1 vs peer N+1)
    // cannot wipe the peer. Over an existing tombstone, same-or-newer is enough.
    if (isClearedAuth(incoming)) {
      if (isClearedAuth(existing)) return inRev >= exRev;
      return inRev > exRev;
    }

    // Never-authenticated empty slot (no tombstone rev).
    if (isClearedAuth(existing) && exRev === 0) return true;

    // Logout tombstone: only a newer revision (fresh login) may restore tokens.
    if (isClearedAuth(existing)) return inRev > exRev;

    const exRef = existing.state?.refreshToken;
    const inRef = incoming.state?.refreshToken;

    // Same refresh: allow access-only updates (e.g. e2e memory expiry pin),
    // but never rewind the persisted revision.
    if (exRef && inRef && exRef === inRef) return inRev >= exRev;

    // Different refresh (rotation, account switch) or missing side: newer rev wins.
    return inRev > exRev;
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
      // localStorage has no CAS; a peer write after this check can still race.
      base.setItem(name, value);
    },
    removeItem: (name) => base.removeItem(name),
  };
});

/** Persisted authRev from `ts6-auth`, or 0 when missing/unreadable. */
export function readPersistedAuthRev(): number {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const raw = localStorage.getItem('ts6-auth');
    if (!raw) return 0;
    return blobRev(JSON.parse(raw) as PersistedAuthBlob);
  } catch {
    return 0;
  }
}

/**
 * Cross-tab logout policy (intentional):
 *
 * - Explicit logout that successfully tombstones `ts6-auth` is a *family*
 *   logout: broadcast the tombstone `authRev` so peers still on an older
 *   memory rev clear too (shared refresh family must not survive one tab's
 *   intentional sign-out).
 * - A stale tab whose tombstone is rejected by `shouldPersistAuthBlob`
 *   (peer already holds a live newer/tied session) must **not** broadcast —
 *   peers keep the winning session (`shouldBroadcastAuthLogout`).
 * - Receivers ignore a logout BC when the origin rev does not beat local
 *   memory, or when live persist is already at/above that rev (login or
 *   rotation won storage while this tab lagged).
 * - Legacy BC messages without `authRev` still apply (fail toward logout).
 * - Login/rotation bumps use max(memory, persist)+1; logout bumps are
 *   memory-only so a stale tab cannot mint past a peer login.
 */

/**
 * Whether a peer-tab logout BC message should clear this tab.
 * Compares origin tombstone rev to both memory and persisted live session —
 * not memory alone (a lagging receiver can sit below persist).
 */
export function shouldApplyPeerAuthLogout(input: {
  originAuthRev: number | undefined;
  localMemoryAuthRev: number;
  persistedAuthRev: number;
  persistedLive: boolean;
}): boolean {
  if (typeof input.originAuthRev !== 'number' || !Number.isFinite(input.originAuthRev)) {
    // Legacy messages without authRev keep prior global-logout behaviour.
    return true;
  }
  // Live persist at/above the logout rev means a newer session won storage —
  // ignore the stale relay even if this tab's memory still lags.
  if (input.persistedLive && input.persistedAuthRev >= input.originAuthRev) {
    return false;
  }
  return input.originAuthRev > input.localMemoryAuthRev;
}

/** After local logout persist: broadcast only when the tombstone actually landed. */
export function shouldBroadcastAuthLogout(persistedLive: boolean): boolean {
  return !persistedLive;
}

/** Bump past both in-memory and persisted rev so a lagging login/rotation cannot tie. */
function nextAuthRev(memoryRev: number): number {
  return Math.max(memoryRev, readPersistedAuthRev()) + 1;
}

/**
 * Logout bump stays local to this tab's memory. Using persist-max here would
 * let a stale tab mint a tombstone newer than a peer login and wipe it.
 */
function nextLogoutAuthRev(memoryRev: number): number {
  return memoryRev + 1;
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
      authRev: 0,
      setAuth: (accessToken, refreshToken, user) => {
        const previousRefreshToken = get().refreshToken;
        set({
          accessToken,
          refreshToken,
          user,
          authRev: nextAuthRev(get().authRev),
        });
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
      setTokens: (accessToken, refreshToken) => {
        const prevRefresh = get().refreshToken;
        // Bump only when the refresh token changes (rotation / session replace).
        // Same-refresh access updates keep authRev so peers with an older rev
        // cannot win by rewriting access alone after a rotation.
        if (prevRefresh !== refreshToken) {
          set({ accessToken, refreshToken, authRev: nextAuthRev(get().authRev) });
        } else {
          set({ accessToken, refreshToken });
        }
      },
      setUser: (user) => set({ user }),
      logout: () => {
        // Clear auth first so a localStorage throw while persisting
        // ts6-server cannot leave the session active. Memory-only bump +
        // shouldPersistAuthBlob (cleared-over-live needs inRev > exRev) so a
        // stale tab cannot wipe a peer session, while same-tab logout still
        // tombstones ahead of delayed restores.
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          authRev: nextLogoutAuthRev(get().authRev),
        });
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
