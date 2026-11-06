import axios from 'axios';
import { useAuthStore } from '../stores/auth.store';
import { useMediaSwitchStore } from '../stores/media-switch.store';
import { conflictIsReplaceable, isMediaSessionConflict, withReplaceSessionIds } from '../lib/media-switch';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

/** Single in-flight refresh per tab; serialized across tabs via Web Lock. */
let refreshPromise: Promise<string | null> | null = null;

const REFRESH_TIMEOUT_MS = 15000;

/** Latest refresh token from zustand persist (`ts6-auth`), not possibly-stale memory. */
export function readPersistedRefreshToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem('ts6-auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { refreshToken?: string | null } };
    const token = parsed.state?.refreshToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const runRefresh = async (refreshToken: string): Promise<string | null> => {
      const { setTokens, logout } = useAuthStore.getState();

      try {
        const res = await axios.post(
          '/api/auth/refresh',
          { refreshToken },
          { timeout: REFRESH_TIMEOUT_MS },
        );
        setTokens(res.data.accessToken, res.data.refreshToken);
        return res.data.accessToken as string;
      } catch (err: unknown) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 401 || status === 403) {
          logout();
        }
        return null;
      }
    };

    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request('ts6-auth-refresh', async () => {
        // Re-read after acquiring the lock so a peer tab's rotation is visible.
        // Memory-only getState() can still hold the pre-rotation token and would
        // present as replay, revoking the whole family.
        const latest = readPersistedRefreshToken() ?? useAuthStore.getState().refreshToken;
        if (!latest) {
          useAuthStore.getState().logout();
          return null;
        }
        const mem = useAuthStore.getState();
        if (mem.refreshToken !== latest) {
          // Sync memory to peer-tab rotation without inventing an access token.
          useAuthStore.setState({ refreshToken: latest });
        }
        return runRefresh(latest);
      });
    }

    // No Web Lock: still prefer persisted token over possibly-stale memory.
    const token = readPersistedRefreshToken() ?? useAuthStore.getState().refreshToken;
    if (!token) {
      useAuthStore.getState().logout();
      return null;
    }
    return runRefresh(token);
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
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
