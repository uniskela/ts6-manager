import axios from 'axios';
import { useAuthStore } from '../stores/auth.store';
import { useMediaSwitchStore } from '../stores/media-switch.store';
import { conflictIsReplaceable, isMediaSessionConflict, withReplaceSessionIds } from '../lib/media-switch';
import {
  broadcastAuthLogout,
  clearAuthRefreshCoordination,
  coordinateRefreshOwnership,
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

function accessTokenNeedsRefresh(token: string, skewSeconds = 30): boolean {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return false;
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === 'number'
      && payload.exp * 1000 <= Date.now() + skewSeconds * 1000;
  } catch {
    // Leave malformed/non-JWT tokens to the normal 401 response path.
    return false;
  }
}

/**
 * If a peer tab already rotated into persist with a still-valid access token,
 * adopt that pair and skip another network rotation.
 * Only adopt when the refresh token changed — a memory-only access expiry must
 * still hit the network with the current refresh token.
 */
function adoptPeerTokensIfFresh(): string | null {
  const persisted = readPersistedAuthTokens();
  const mem = useAuthStore.getState();
  if (!persisted.refreshToken || persisted.refreshToken === mem.refreshToken) return null;

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
        setTokens(accessToken, nextRefresh);
        return { accessToken, refreshToken: nextRefresh };
      } catch (err: unknown) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 401 || status === 403) {
          // Dual-start race: peer may have rotated; zustand persist can lag setTokens.
          for (let i = 0; i < 3; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 25));
            const persisted = readPersistedAuthTokens();
            if (
              persisted.refreshToken
              && persisted.refreshToken !== refreshToken
              && persisted.accessToken
            ) {
              useAuthStore.setState({
                accessToken: persisted.accessToken,
                refreshToken: persisted.refreshToken,
              });
              return {
                accessToken: persisted.accessToken,
                refreshToken: persisted.refreshToken,
              };
            }
          }
          logout();
        }
        return null;
      }
    };

    const resolveRefresh = async (): Promise<string | null> => {
      // Peer tab may have finished while we waited for the lock / coalesced promise.
      const adopted = adoptPeerTokensIfFresh();
      if (adopted) return adopted;

      const latest = readPersistedAuthTokens().refreshToken ?? useAuthStore.getState().refreshToken;
      if (!latest) {
        useAuthStore.getState().logout();
        return null;
      }
      const pair = await runRefresh(latest);
      return pair?.accessToken ?? null;
    };

    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request('ts6-auth-refresh', resolveRefresh);
    }

    // No Web Lock (plain HTTP LAN, older browsers): elect one refresher via
    // BroadcastChannel, followers wait for the result instead of dual-POST.
    const owned = async (): Promise<string | null> => {
      const adopted = adoptPeerTokensIfFresh();
      if (adopted) return adopted;

      const attempt = async (): Promise<string | null> => {
        const pair = await coordinateRefreshOwnership(async () => {
          const again = adoptPeerTokensIfFresh();
          if (again) {
            const persisted = readPersistedAuthTokens();
            if (persisted.accessToken && persisted.refreshToken) {
              return { accessToken: persisted.accessToken, refreshToken: persisted.refreshToken };
            }
          }
          const latest = readPersistedAuthTokens().refreshToken ?? useAuthStore.getState().refreshToken;
          if (!latest) {
            useAuthStore.getState().logout();
            return null;
          }
          return runRefresh(latest);
        });
        if (!pair) return null;
        useAuthStore.setState({
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
        });
        return pair.accessToken;
      };

      const first = await attempt();
      if (first) return first;
      // Winner crashed / message lost: one bounded retry after re-reading persist.
      const adoptedAfter = adoptPeerTokensIfFresh();
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
  window.addEventListener('ts6-auth-session', () => {
    clearAuthRefreshCoordination();
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

/** Playwright-only seam: enabled when localStorage ts6-e2e-hooks=1 before module load. */
function installE2EAuthHooks(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem('ts6-e2e-hooks') !== '1') return;
  } catch {
    return;
  }
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
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 120 }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      // Memory-only expiry: restore persist after setState so a peer tab's
      // rotated refresh is not overwritten by stale in-memory state.
      const snap = localStorage.getItem('ts6-auth');
      useAuthStore.setState({ accessToken: `${header}.${payload}.e2e-expired` });
      if (snap) {
        localStorage.setItem('ts6-auth', snap);
        await Promise.resolve();
        localStorage.setItem('ts6-auth', snap);
      }
    },
    refreshNow: () => refreshAccessToken(),
    logoutLocal: () => useAuthStore.getState().logout(),
  };
}
installE2EAuthHooks();

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
