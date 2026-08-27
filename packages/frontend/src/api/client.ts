import axios from 'axios';
import { useAuthStore } from '../stores/auth.store';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

/** Single in-flight refresh per tab; serialized across tabs via Web Lock. */
let refreshPromise: Promise<string | null> | null = null;

const REFRESH_TIMEOUT_MS = 15000;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const runRefresh = async (): Promise<string | null> => {
      const { refreshToken, setTokens, logout } = useAuthStore.getState();
      if (!refreshToken) {
        logout();
        return null;
      }

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
        const persisted = useAuthStore.getState();
        if (!persisted.refreshToken) {
          persisted.logout();
          return null;
        }
        return runRefresh();
      });
    }

    return runRefresh();
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
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
    return Promise.reject(error);
  },
);

export default api;
