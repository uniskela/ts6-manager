/**
 * Cross-tab refresh ownership when Web Locks are unavailable (e.g. plain HTTP LAN).
 *
 * BroadcastChannel is same-origin only and is not atomic — this module elects a
 * single refresher via a short claim window, announces leadership before the
 * network call, and lets followers wait for a bounded result (or time out and
 * retry once). It does not replace server-side replay detection.
 */

export const AUTH_REFRESH_CHANNEL = 'ts6-auth-refresh';
export const CLAIM_WINDOW_MS = 80;
export const RESULT_WAIT_MS = 16_000;

export type AuthRefreshBcMessage =
  | { v: 1; type: 'claim'; tabId: string }
  | { v: 1; type: 'leader'; tabId: string }
  | {
    v: 1;
    type: 'result';
    tabId: string;
    ok: true;
    accessToken: string;
    refreshToken: string;
  }
  | { v: 1; type: 'result'; tabId: string; ok: false }
  | { v: 1; type: 'logout'; tabId: string };

type TokenPair = { accessToken: string; refreshToken: string };

let tabIdMemo: string | null = null;
let channel: BroadcastChannel | null | undefined;
let activeLeader: string | null = null;
let lastGoodResult: (TokenPair & { at: number }) | null = null;
let resultWaiters: Array<(msg: AuthRefreshBcMessage & { type: 'result' }) => void> = [];
let peerLogoutHandler: (() => void) | null = null;
let suppressLogoutBroadcast = false;
let listenerInstalled = false;

export function getAuthRefreshTabId(): string {
  if (tabIdMemo) return tabIdMemo;
  tabIdMemo = `t-${Math.random().toString(36).slice(2, 12)}-${Date.now().toString(36)}`;
  return tabIdMemo;
}

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  // Browser-only: Node's BroadcastChannel keeps the event loop alive in unit tests.
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    channel = null;
    return null;
  }
  try {
    channel = new BroadcastChannel(AUTH_REFRESH_CHANNEL);
  } catch {
    channel = null;
  }
  return channel;
}

function isMessage(data: unknown): data is AuthRefreshBcMessage {
  return Boolean(
    data
    && typeof data === 'object'
    && (data as { v?: unknown }).v === 1
    && typeof (data as { type?: unknown }).type === 'string',
  );
}

function ensureListener(): void {
  if (listenerInstalled) return;
  const ch = getChannel();
  if (!ch) return;
  listenerInstalled = true;
  ch.addEventListener('message', (ev: MessageEvent) => {
    if (!isMessage(ev.data)) return;
    const msg = ev.data;
    if (msg.type === 'leader') {
      // Prefer lexicographically smaller leader if two announce.
      if (!activeLeader || msg.tabId < activeLeader || msg.tabId === activeLeader) {
        activeLeader = msg.tabId;
      }
      return;
    }
    if (msg.type === 'result') {
      if (msg.ok) {
        lastGoodResult = {
          accessToken: msg.accessToken,
          refreshToken: msg.refreshToken,
          at: Date.now(),
        };
        activeLeader = null;
        const waiters = resultWaiters;
        resultWaiters = [];
        for (const w of waiters) w(msg);
        return;
      }
      // ok:false from a lost dual-start — do not poison waiters if a peer already succeeded.
      if (lastGoodResult && Date.now() - lastGoodResult.at < RESULT_WAIT_MS) {
        const waiters = resultWaiters;
        resultWaiters = [];
        for (const w of waiters) {
          w({
            v: 1,
            type: 'result',
            tabId: msg.tabId,
            ok: true,
            accessToken: lastGoodResult.accessToken,
            refreshToken: lastGoodResult.refreshToken,
          });
        }
        activeLeader = null;
        return;
      }
      activeLeader = null;
      const waiters = resultWaiters;
      resultWaiters = [];
      for (const w of waiters) w(msg);
      return;
    }
    if (msg.type === 'logout' && msg.tabId !== getAuthRefreshTabId()) {
      peerLogoutHandler?.();
    }
  });
}

export function setAuthRefreshPeerLogoutHandler(handler: (() => void) | null): void {
  peerLogoutHandler = handler;
  ensureListener();
}

export function broadcastAuthLogout(): void {
  if (suppressLogoutBroadcast) return;
  const ch = getChannel();
  if (!ch) return;
  ensureListener();
  try {
    ch.postMessage({ v: 1, type: 'logout', tabId: getAuthRefreshTabId() } satisfies AuthRefreshBcMessage);
  } catch {
    // Channel closed / unavailable — local logout still proceeds.
  }
}

export function runWithoutLogoutBroadcast(fn: () => void): void {
  suppressLogoutBroadcast = true;
  try {
    fn();
  } finally {
    suppressLogoutBroadcast = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic owner among claim tab ids (lexicographically smallest). */
export function pickRefreshOwner(claimTabIds: string[]): string {
  if (claimTabIds.length === 0) return getAuthRefreshTabId();
  return [...claimTabIds].sort()[0]!;
}

function waitForResult(timeoutMs: number): Promise<TokenPair | null> {
  ensureListener();
  if (lastGoodResult && Date.now() - lastGoodResult.at < 2_000) {
    return Promise.resolve({
      accessToken: lastGoodResult.accessToken,
      refreshToken: lastGoodResult.refreshToken,
    });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resultWaiters = resultWaiters.filter((w) => w !== onResult);
      if (lastGoodResult && Date.now() - lastGoodResult.at < RESULT_WAIT_MS) {
        resolve({
          accessToken: lastGoodResult.accessToken,
          refreshToken: lastGoodResult.refreshToken,
        });
        return;
      }
      resolve(null);
    }, timeoutMs);

    const onResult = (msg: AuthRefreshBcMessage & { type: 'result' }) => {
      clearTimeout(timer);
      if (!msg.ok) {
        resolve(null);
        return;
      }
      resolve({ accessToken: msg.accessToken, refreshToken: msg.refreshToken });
    };
    resultWaiters.push(onResult);
  });
}

/**
 * Elect a single refresher among same-origin tabs, or wait for a peer's result.
 * Returns null when refresh failed / timed out (caller may retry once).
 */
export async function coordinateRefreshOwnership(
  executeRefresh: () => Promise<TokenPair | null>,
): Promise<TokenPair | null> {
  const ch = getChannel();
  ensureListener();
  if (!ch) return executeRefresh();

  if (lastGoodResult && Date.now() - lastGoodResult.at < 2_000) {
    return {
      accessToken: lastGoodResult.accessToken,
      refreshToken: lastGoodResult.refreshToken,
    };
  }

  // Peer already refreshing — wait instead of starting a competing POST.
  if (activeLeader && activeLeader !== getAuthRefreshTabId()) {
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
  }

  const claims = new Set<string>([getAuthRefreshTabId()]);
  const onClaim = (ev: MessageEvent) => {
    if (!isMessage(ev.data) || ev.data.type !== 'claim') return;
    if (typeof ev.data.tabId === 'string' && ev.data.tabId.length > 0) {
      claims.add(ev.data.tabId);
    }
  };
  ch.addEventListener('message', onClaim);
  try {
    // Two pulses: late starters miss the first claim (BC does not buffer).
    const pulse = () => {
      try {
        ch.postMessage({ v: 1, type: 'claim', tabId: getAuthRefreshTabId() } satisfies AuthRefreshBcMessage);
      } catch {
        // Channel closed — fall through to local refresh.
      }
    };
    pulse();
    await sleep(CLAIM_WINDOW_MS);
    pulse();
    await sleep(CLAIM_WINDOW_MS);
  } finally {
    ch.removeEventListener('message', onClaim);
  }

  // Leader may have appeared while we claimed.
  if (activeLeader && activeLeader !== getAuthRefreshTabId()) {
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
  }

  const winner = pickRefreshOwner([...claims]);
  if (winner !== getAuthRefreshTabId()) {
    return waitForResult(RESULT_WAIT_MS);
  }

  activeLeader = getAuthRefreshTabId();
  try {
    ch.postMessage({ v: 1, type: 'leader', tabId: getAuthRefreshTabId() } satisfies AuthRefreshBcMessage);
  } catch {
    // Continue — we still own locally.
  }
  // Brief settle so a smaller-id leader can steal before we POST.
  await sleep(30);
  if (activeLeader && activeLeader !== getAuthRefreshTabId()) {
    return waitForResult(RESULT_WAIT_MS);
  }

  try {
    const pair = await executeRefresh();
    try {
      if (pair) {
        lastGoodResult = { ...pair, at: Date.now() };
        ch.postMessage({
          v: 1,
          type: 'result',
          tabId: getAuthRefreshTabId(),
          ok: true,
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
        } satisfies AuthRefreshBcMessage);
      } else if (!(lastGoodResult && Date.now() - lastGoodResult.at < RESULT_WAIT_MS)) {
        ch.postMessage({
          v: 1,
          type: 'result',
          tabId: getAuthRefreshTabId(),
          ok: false,
        } satisfies AuthRefreshBcMessage);
      } else {
        return {
          accessToken: lastGoodResult.accessToken,
          refreshToken: lastGoodResult.refreshToken,
        };
      }
    } catch {
      // Followers will time out and retry.
    }
    return pair;
  } finally {
    if (activeLeader === getAuthRefreshTabId()) activeLeader = null;
  }
}

/** Test-only reset of module state. */
export function resetAuthRefreshCoordForTests(): void {
  tabIdMemo = null;
  activeLeader = null;
  lastGoodResult = null;
  resultWaiters = [];
  suppressLogoutBroadcast = false;
  if (channel) {
    try {
      channel.close();
    } catch {
      // ignore
    }
  }
  channel = undefined;
  listenerInstalled = false;
}
