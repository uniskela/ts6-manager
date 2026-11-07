import axios from 'axios';
import { shouldPersistAuthBlob, useAuthStore } from '../stores/auth.store';
import { useMediaSwitchStore } from '../stores/media-switch.store';
import { conflictIsReplaceable, isMediaSessionConflict, withReplaceSessionIds } from '../lib/media-switch';
import {
  broadcastAuthLogout,
  clearAuthRefreshCoordination,
  coordinateRefreshOwnership,
  getAuthRefreshCoordinationEpoch,
  isPersistedRefreshAdoptionAllowed,
  markLocalRefreshSuccess,
  runWithoutLogoutBroadcast,
  setAuthRefreshPeerLogoutHandler,
} from './auth-refresh-coord';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

/** Single in-flight refresh per tab; serialized across tabs via Web Lock. */
let refreshPromise: Promise<string | null> | null = null;

const REFRESH_TIMEOUT_MS = 15000;

/** Latest auth tokens from zustand persist (`ts6-auth`), not possibly-stale memory. */
export function readPersistedAuthTokens(): {
  accessToken: string | null;
  refreshToken: string | null;
} {
  if (typeof localStorage === 'undefined') {
    return { accessToken: null, refreshToken: null };
  }
  try {
    const raw = localStorage.getItem('ts6-auth');
    if (!raw) return { accessToken: null, refreshToken: null };
    const parsed = JSON.parse(raw) as {
      state?: { accessToken?: string | null; refreshToken?: string | null };
    };
    const access = parsed.state?.accessToken;
    const refresh = parsed.state?.refreshToken;
    return {
      accessToken: typeof access === 'string' && access.length > 0 ? access : null,
      refreshToken: typeof refresh === 'string' && refresh.length > 0 ? refresh : null,
    };
  } catch {
    return { accessToken: null, refreshToken: null };
  }
}

/** @deprecated Prefer readPersistedAuthTokens(); kept for unit tests. */
export function readPersistedRefreshToken(): string | null {
  return readPersistedAuthTokens().refreshToken;
}

function decodeAccessPayload(token: string): { id?: unknown; exp?: unknown } | null {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(atob(padded)) as { id?: unknown; exp?: unknown };
  } catch {
    return null;
  }
}

function accessTokenNeedsRefresh(token: string, skewSeconds = 30): boolean {
  const payload = decodeAccessPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    // Leave malformed/non-JWT tokens to the normal 401 response path.
    return false;
  }
  return payload.exp * 1000 <= Date.now() + skewSeconds * 1000;
}

/** JWT `id` claim from an access token (unverified decode — identity compare only). */
export function accessTokenUserId(token: string | null | undefined): number | null {
  if (!token) return null;
  const payload = decodeAccessPayload(token);
  return typeof payload?.id === 'number' ? payload.id : null;
}

/**
 * Persist/BC adoption gate: epoch + blocked set + same JWT subject.
 * Subject check covers peer login that rewrote `ts6-auth` without notifying this tab.
 */
export function canAdoptPersistedAuth(input: {
  startEpoch: number;
  currentEpoch: number;
  expectedAccessToken: string | null;
  presentedRefreshToken: string | null;
  persistedAccessToken: string | null;
  persistedRefreshToken: string | null;
  adoptionAllowed: (refreshToken: string) => boolean;
}): boolean {
  if (input.currentEpoch !== input.startEpoch) return false;
  if (!input.persistedRefreshToken || !input.persistedAccessToken) return false;
  if (
    input.presentedRefreshToken
    && input.persistedRefreshToken === input.presentedRefreshToken
  ) {
    return false;
  }
  if (!input.adoptionAllowed(input.persistedRefreshToken)) return false;
  const expectedId = accessTokenUserId(input.expectedAccessToken);
  const persistedId = accessTokenUserId(input.persistedAccessToken);
  if (expectedId == null || persistedId == null || expectedId !== persistedId) return false;
  return true;
}

/**
 * Drop a late refresh response when the originating session is no longer current.
 * Epoch covers logout and same-account re-login (JWT id alone is not enough).
 */
export function shouldApplyRefreshResponse(input: {
  startEpoch: number;
  currentEpoch: number;
  expectedAccessToken: string | null;
  currentAccessToken: string | null;
  responseAccessToken: string;
}): 'apply' | 'discard' {
  if (input.currentEpoch !== input.startEpoch) return 'discard';
  // Logged out while in flight (epoch may already match if clear was skipped).
  if (input.expectedAccessToken && !input.currentAccessToken) return 'discard';
  const expectedId = accessTokenUserId(input.expectedAccessToken);
  const responseId = accessTokenUserId(input.responseAccessToken);
  const currentId = accessTokenUserId(input.currentAccessToken);
  if (expectedId == null) {
    if (currentId != null && responseId !== currentId) return 'discard';
    return 'apply';
  }
  if (responseId !== expectedId) return 'discard';
  if (currentId != null && currentId !== expectedId) return 'discard';
  return 'apply';
}

/**
 * If a peer tab already rotated into persist with a still-valid access token,
 * adopt that pair and skip another network rotation.
 * Only adopt when the refresh token changed — a memory-only access expiry must
 * still hit the network with the current refresh token.
 */
function adoptPeerTokensIfFresh(
  startEpoch: number,
  expectedAccessToken: string | null,
): string | null {
  const persisted = readPersistedAuthTokens();
  const mem = useAuthStore.getState();
  if (!canAdoptPersistedAuth({
    startEpoch,
    currentEpoch: getAuthRefreshCoordinationEpoch(),
    expectedAccessToken,
    presentedRefreshToken: mem.refreshToken,
    persistedAccessToken: persisted.accessToken,
    persistedRefreshToken: persisted.refreshToken,
    adoptionAllowed: isPersistedRefreshAdoptionAllowed,
  })) {
    return null;
  }

  useAuthStore.setState({
    refreshToken: persisted.refreshToken,
    ...(persisted.accessToken ? { accessToken: persisted.accessToken } : {}),
  });

  if (persisted.accessToken && !accessTokenNeedsRefresh(persisted.accessToken)) {
    return persisted.accessToken;
  }
  return null;
}
async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const startEpoch = getAuthRefreshCoordinationEpoch();
    const expectedAccessToken = useAuthStore.getState().accessToken;

    const runRefresh = async (refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | null> => {
      const { setTokens, logout } = useAuthStore.getState();

      try {
        const res = await axios.post(
          '/api/auth/refresh',
          { refreshToken },
          { timeout: REFRESH_TIMEOUT_MS },
        );
        const accessToken = res.data.accessToken as string;
        const nextRefresh = res.data.refreshToken as string;
        if (shouldApplyRefreshResponse({
          startEpoch,
          currentEpoch: getAuthRefreshCoordinationEpoch(),
          expectedAccessToken,
          currentAccessToken: useAuthStore.getState().accessToken,
          responseAccessToken: accessToken,
        }) === 'discard') {
          return null;
        }
        setTokens(accessToken, nextRefresh);
        return { accessToken, refreshToken: nextRefresh };
      } catch (err: unknown) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 401 || status === 403) {
          // Dual-start race: peer may have rotated; zustand persist can lag setTokens.
          // Reject other-account persist even when this tab never saw logout/session BC.
          for (let i = 0; i < 3; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 25));
            if (getAuthRefreshCoordinationEpoch() !== startEpoch) {
              // Newer login/logout owns the tab — do not adopt or logout over it.
              return null;
            }
            const persisted = readPersistedAuthTokens();
            if (canAdoptPersistedAuth({
              startEpoch,
              currentEpoch: getAuthRefreshCoordinationEpoch(),
              expectedAccessToken,
              presentedRefreshToken: refreshToken,
              persistedAccessToken: persisted.accessToken,
              persistedRefreshToken: persisted.refreshToken,
              adoptionAllowed: isPersistedRefreshAdoptionAllowed,
            })) {
              useAuthStore.setState({
                accessToken: persisted.accessToken,
                refreshToken: persisted.refreshToken,
              });
              return {
                accessToken: persisted.accessToken!,
                refreshToken: persisted.refreshToken!,
              };
            }
          }
          if (getAuthRefreshCoordinationEpoch() !== startEpoch) return null;
          logout();
        }
        return null;
      }
    };

    const resolveRefresh = async (): Promise<string | null> => {
      // Peer tab may have finished while we waited for the lock / coalesced promise.
      const adopted = adoptPeerTokensIfFresh(startEpoch, expectedAccessToken);
      if (adopted) return adopted;
      if (getAuthRefreshCoordinationEpoch() !== startEpoch) return null;
      const latest = readPersistedAuthTokens().refreshToken ?? useAuthStore.getState().refreshToken;
      if (!latest) {
        if (getAuthRefreshCoordinationEpoch() !== startEpoch) return null;
        useAuthStore.getState().logout();
        return null;
      }
      const pair = await runRefresh(latest);
      if (!pair) return null;
      // Web Lock path must clear ignorePeerResults like BC ownership does.
      markLocalRefreshSuccess(pair, startEpoch);
      return pair.accessToken;
    };
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request('ts6-auth-refresh', resolveRefresh);
    }

    // No Web Lock (plain HTTP LAN, older browsers): elect one refresher via
    // BroadcastChannel, followers wait for the result instead of dual-POST.
    const owned = async (): Promise<string | null> => {
      const adopted = adoptPeerTokensIfFresh(startEpoch, expectedAccessToken);
      if (adopted) return adopted;

      const attempt = async (): Promise<string | null> => {
        const pair = await coordinateRefreshOwnership(async () => {
          const again = adoptPeerTokensIfFresh(startEpoch, expectedAccessToken);
          if (again) {
            const persisted = readPersistedAuthTokens();
            if (persisted.accessToken && persisted.refreshToken) {
              return { accessToken: persisted.accessToken, refreshToken: persisted.refreshToken };
            }
          }
          if (getAuthRefreshCoordinationEpoch() !== startEpoch) return null;
          const latest = readPersistedAuthTokens().refreshToken ?? useAuthStore.getState().refreshToken;
          if (!latest) {
            if (getAuthRefreshCoordinationEpoch() !== startEpoch) return null;
            useAuthStore.getState().logout();
            return null;
          }
          return runRefresh(latest);
        });
        if (!pair) return null;
        if (shouldApplyRefreshResponse({
          startEpoch,
          currentEpoch: getAuthRefreshCoordinationEpoch(),
          expectedAccessToken,
          currentAccessToken: useAuthStore.getState().accessToken,
          responseAccessToken: pair.accessToken,
        }) === 'discard') {
          return null;
        }
        useAuthStore.setState({
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
        });
        return pair.accessToken;
      };

      const first = await attempt();
      if (first) return first;
      // Winner crashed / message lost: one bounded retry after re-reading persist.
      const adoptedAfter = adoptPeerTokensIfFresh(startEpoch, expectedAccessToken);
      if (adoptedAfter) return adoptedAfter;
      return attempt();
    };

    return owned();
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

if (typeof window !== 'undefined') {
  setAuthRefreshPeerLogoutHandler(() => {
    runWithoutLogoutBroadcast(() => {
      useAuthStore.getState().logout();
    });
  });
  window.addEventListener('ts6-auth-logout', () => {
    broadcastAuthLogout();
  });
  window.addEventListener('ts6-auth-session', (ev: Event) => {
    const previousRefreshToken = (ev as CustomEvent<{ previousRefreshToken?: string | null }>).detail
      ?.previousRefreshToken ?? null;
    clearAuthRefreshCoordination(previousRefreshToken);
  });
}

api.interceptors.request.use(async (config) => {
  let token = useAuthStore.getState().accessToken;

  // Persisted access tokens can expire while the app is closed. Refresh before
  // /servers, /auth/me, and other protected bootstrap requests so a normal
  // resume does not intentionally generate a burst of 401s first.
  if (token && accessTokenNeedsRefresh(token)) {
    token = await refreshAccessToken();
  }

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  } else {
    delete config.headers.Authorization;
  }
  return config;
});

/** Base64url without regex backtracking (Playwright E2E builds only). */
function toBase64UrlJson(value: unknown): string {
  const b64 = btoa(JSON.stringify(value));
  let out = '';
  for (let i = 0; i < b64.length; i++) {
    const c = b64[i]!;
    if (c === '+') out += '-';
    else if (c === '/') out += '_';
    else if (c !== '=') out += c;
  }
  return out;
}

/**
 * Playwright-only seam. Compiled in only when `VITE_E2E_AUTH_HOOKS=true`
 * (`pnpm build:e2e`). Ordinary production/Docker builds tree-shake this away —
 * a localStorage flag alone must not unlock hooks in release images.
 */
function installE2EAuthHooks(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  (window as Window & {
    __ts6AuthTest?: {
      getMemoryTokens: () => { accessToken: string | null; refreshToken: string | null };
      expireAccessInMemory: () => Promise<void>;
      refreshNow: () => Promise<string | null>;
      logoutLocal: () => void;
    };
  }).__ts6AuthTest = {
    getMemoryTokens: () => {
      const { accessToken, refreshToken } = useAuthStore.getState();
      return { accessToken, refreshToken };
    },
    expireAccessInMemory: async () => {
      const mem = useAuthStore.getState();
      const priorId = accessTokenUserId(mem.accessToken);
      const header = toBase64UrlJson({ alg: 'none', typ: 'JWT' });
      // Keep subject `id` so same-account adopt gates still work after expiry.
      const payload = toBase64UrlJson({
        ...(priorId != null ? { id: priorId } : {}),
        exp: Math.floor(Date.now() / 1000) - 120,
      });
      const expiredAccess = `${header}.${payload}.e2e-expired`;
      const snapRaw = localStorage.getItem('ts6-auth');
      // setState persists {expiredAccess, memoryRefresh} and can rewind a peer
      // rotation. Pin ts6-auth during setState:
      // - peer advanced (persist refresh ≠ memory): keep full peer snap (valid
      //   access) so adoptPeerTokensIfFresh can skip a second network rotate;
      // - otherwise expire access in persist too so we cannot "adopt" the same
      //   login access without rotating.
      let pinned = snapRaw;
      if (snapRaw) {
        try {
          const snap = JSON.parse(snapRaw) as {
            state?: { accessToken?: string; refreshToken?: string; user?: unknown };
            version?: number;
          };
          const persistRefresh = snap.state?.refreshToken;
          if (!persistRefresh || !mem.refreshToken || persistRefresh === mem.refreshToken) {
            pinned = JSON.stringify({
              ...snap,
              state: { ...snap.state, accessToken: expiredAccess },
            });
          }
        } catch {
          pinned = snapRaw;
        }
      }
      if (!pinned) {
        useAuthStore.setState({ accessToken: expiredAccess });
        return;
      }
      const rawSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = (key: string, value: string) => {
        rawSet(key, key === 'ts6-auth' ? pinned! : value);
      };
      try {
        useAuthStore.setState({ accessToken: expiredAccess });
      } finally {
        localStorage.setItem = rawSet;
        // Re-check at commit time: a peer rotation may have landed after snapRaw.
        // Bypass authStorage otherwise and rewind R2→R1.
        if (shouldPersistAuthBlob(localStorage.getItem('ts6-auth'), pinned)) {
          rawSet('ts6-auth', pinned);
        }
      }
    },
    refreshNow: () => refreshAccessToken(),
    logoutLocal: () => useAuthStore.getState().logout(),
  };
}
// `__TS6_E2E_AUTH_HOOKS__` is a Vite define (false in Docker/release builds → DCE).
// Node unit tests: treat an undeclared global as false.
if (typeof __TS6_E2E_AUTH_HOOKS__ !== 'undefined' && __TS6_E2E_AUTH_HOOKS__) {
  installE2EAuthHooks();
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && original && !original._retry) {
      original._retry = true;
      const newToken = await refreshAccessToken();
      if (newToken) {
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      }
    }
    // Single media session: confirm replacing the active music/video, then
    // resend the same request naming exactly the sessions it may stop.
    const data = error.response?.data;
    if (error.response?.status === 409 && original && !original._mediaSwitchRetry && isMediaSessionConflict(data)) {
      const confirmed = await useMediaSwitchStore.getState().request(data);
      if (confirmed && conflictIsReplaceable(data)) {
        original._mediaSwitchRetry = true;
        original.data = JSON.stringify(withReplaceSessionIds(original.data, data.conflicts.map((c) => c.id)));
        return api(original);
      }
      data.error = 'Cancelled — what was playing keeps playing.';
      data.details = undefined;
    }
    return Promise.reject(error);
  },
);

export default api;
