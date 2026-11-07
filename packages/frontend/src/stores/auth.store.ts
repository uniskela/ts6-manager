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
  /**
   * Opaque client session lineage. Minted on login (`setAuth`), kept across
   * refresh rotation (`setTokens`), cleared on logout. Distinguishes same-family
   * rotation from a new login (including same account) without using JWT subject
   * or raw refresh tokens.
   */
  sessionKey: string | null;
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
    sessionKey?: string | null;
  };
};

function newSessionKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('Web Crypto required to mint sessionKey');
}

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

function readPersistedAuthSnapshot(): {
  authRev: number;
  refreshToken: string | null;
  sessionKey: string | null;
} {
  if (typeof localStorage === 'undefined') {
    return { authRev: 0, refreshToken: null, sessionKey: null };
  }
  try {
    const raw = localStorage.getItem('ts6-auth');
    if (!raw) return { authRev: 0, refreshToken: null, sessionKey: null };
    const parsed = JSON.parse(raw) as PersistedAuthBlob;
    const refresh = parsed.state?.refreshToken;
    const sessionKey = parsed.state?.sessionKey;
    return {
      authRev: blobRev(parsed),
      refreshToken: typeof refresh === 'string' ? refresh : null,
      sessionKey: typeof sessionKey === 'string' && sessionKey.length > 0 ? sessionKey : null,
    };
  } catch {
    return { authRev: 0, refreshToken: null, sessionKey: null };
  }
}

/**
 * Cross-tab logout policy (intentional):
 *
 * - `sessionKey` is the client lineage: same across refresh rotation, new on
 *   login. Refresh-token equality alone cannot tell rotation from re-login.
 * - Explicit logout for the *same* sessionKey tombstones past persist and
 *   broadcasts so peers on a rotated successor clear too.
 * - Stale logout after a *new* login (different sessionKey, including same
 *   account) stays memory-only and does not broadcast when persist stays live.
 * - Receivers ignore a logout BC when live persist is already at/above the
 *   origin rev, or when origin does not beat local memory.
 * - Legacy BC messages without `authRev` still apply (fail toward logout).
 * - Login/rotation bumps use max(memory, persist)+1.
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
 * Logout revision for a tombstone write.
 * - Same `sessionKey` as persist (refresh may have rotated) → beat persist.
 * - Legacy blobs without sessionKey: same refresh still beats persist.
 * - Different sessionKey / different refresh without keys → memory-only bump
 *   so a new login (including same account) is not wiped.
 */
export function nextLogoutAuthRev(input: {
  memoryRev: number;
  memoryRefresh: string | null;
  memorySessionKey: string | null;
  persistedRev: number;
  persistedRefresh: string | null;
  persistedSessionKey: string | null;
}): number {
  const sameSession = Boolean(
    input.memorySessionKey
    && input.persistedSessionKey
    && input.memorySessionKey === input.persistedSessionKey,
  );
  const sameRefreshLegacy = Boolean(
    !input.memorySessionKey
    && !input.persistedSessionKey
    && input.memoryRefresh
    && input.persistedRefresh
    && input.memoryRefresh === input.persistedRefresh,
  );
  if (sameSession || sameRefreshLegacy) {
    return Math.max(input.memoryRev, input.persistedRev) + 1;
  }
  return input.memoryRev + 1;
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
      sessionKey: null,
      setAuth: (accessToken, refreshToken, user) => {
        const previousRefreshToken = get().refreshToken;
        set({
          accessToken,
          refreshToken,
          user,
          authRev: nextAuthRev(get().authRev),
          sessionKey: newSessionKey(),
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
        // sessionKey is unchanged across rotation; mint if a pre-sessionKey
        // blob is still live so later logout can recognise the lineage.
        const sessionKey = get().sessionKey ?? newSessionKey();
        if (prevRefresh !== refreshToken) {
          set({ accessToken, refreshToken, authRev: nextAuthRev(get().authRev), sessionKey });
        } else {
          set({ accessToken, refreshToken, sessionKey });
        }
      },
      setUser: (user) => set({ user }),
      logout: () => {
        // Clear auth first so a localStorage throw while persisting
        // ts6-server cannot leave the session active. Same sessionKey (peer
        // may have rotated refresh) tombstones past persist; a new login with
        // a different sessionKey keeps memory-only rev so the peer survives.
        const persisted = readPersistedAuthSnapshot();
        const tombstoneRev = nextLogoutAuthRev({
          memoryRev: get().authRev,
          memoryRefresh: get().refreshToken,
          memorySessionKey: get().sessionKey,
          persistedRev: persisted.authRev,
          persistedRefresh: persisted.refreshToken,
          persistedSessionKey: persisted.sessionKey,
        });
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          authRev: tombstoneRev,
          sessionKey: null,
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
