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
/** Bumped on logout/session replace so in-flight waits abort instead of adopting prior-account tokens. */
let coordinationEpoch = 0;
/** Refresh tokens from a replaced session — ignore if a late peer still publishes them. */
let blockedRefreshTokens = new Set<string>();
/**
 * After logout/login, ignore peer `result` until this tab publishes its own
 * successful refresh. Blocks rotated successors (R1) of a prior-account R0,
 * not only the exact blocked token string.
 */
let ignorePeerResults = false;

/** UTF-16 code-unit order — locale-independent across browsers. */
export function compareTabIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function randomTabSuffix(): string {
  const bytes = new Uint8Array(8);
  // crypto.getRandomValues works in secure and insecure (HTTP LAN) contexts.
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getAuthRefreshTabId(): string {
  if (tabIdMemo) return tabIdMemo;
  tabIdMemo = `t-${randomTabSuffix()}-${Date.now().toString(36)}`;
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

function clearCoordinationState(previousRefreshToken?: string | null): void {
  // First login has no prior refresh — do not block peer results or same-tab
  // followers hang for RESULT_WAIT_MS after every Sign In.
  const hadPriorSession = Boolean(
    previousRefreshToken
    || lastGoodResult
    || activeLeader
    || resultWaiters.length > 0
    || blockedRefreshTokens.size > 0,
  );
  if (lastGoodResult?.refreshToken) {
    blockedRefreshTokens.add(lastGoodResult.refreshToken);
  }
  if (previousRefreshToken) {
    blockedRefreshTokens.add(previousRefreshToken);
  }
  // Bound memory: keep only the most recent few blocked tokens.
  if (blockedRefreshTokens.size > 8) {
    blockedRefreshTokens = new Set([...blockedRefreshTokens].slice(-8));
  }
  lastGoodResult = null;
  activeLeader = null;
  if (hadPriorSession) ignorePeerResults = true;
  coordinationEpoch += 1;
  const waiters = resultWaiters;
  resultWaiters = [];
  // Fail pending followers immediately — do not leave them to adopt a prior account.
  for (const w of waiters) {
    w({ v: 1, type: 'result', tabId: getAuthRefreshTabId(), ok: false });
  }
}

/** Call when a new login/session replaces credentials (not on same-account token refresh). */
export function clearAuthRefreshCoordination(previousRefreshToken?: string | null): void {
  clearCoordinationState(previousRefreshToken);
}

/** Epoch bumped on logout / session replace — in-flight refresh must not adopt across a bump. */
export function getAuthRefreshCoordinationEpoch(): number {
  return coordinationEpoch;
}

/**
 * Whether persist/BC may adopt this refresh string.
 * False after logout/session replace until this tab completes its own refresh
 * (`ignorePeerResults`), or when the token is in the blocked prior-session set.
 */
export function isPersistedRefreshAdoptionAllowed(refreshToken: string): boolean {
  if (!refreshToken) return false;
  if (ignorePeerResults) return false;
  if (blockedRefreshTokens.has(refreshToken)) return false;
  return true;
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
        if (ignorePeerResults || blockedRefreshTokens.has(msg.refreshToken)) {
          // Prior-session leader finished after logout/login — drop R0 and any
          // rotated successor (R1) until this tab owns a fresh refresh.
          if (msg.refreshToken) blockedRefreshTokens.add(msg.refreshToken);
          if (blockedRefreshTokens.size > 8) {
            blockedRefreshTokens = new Set([...blockedRefreshTokens].slice(-8));
          }
          activeLeader = null;
          return;
        }
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
      clearCoordinationState();
      peerLogoutHandler?.();
    }
  });
}

export function setAuthRefreshPeerLogoutHandler(handler: (() => void) | null): void {
  peerLogoutHandler = handler;
  ensureListener();
}

export function broadcastAuthLogout(): void {
  clearCoordinationState();
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

/** Deterministic owner among claim tab ids (UTF-16 lexicographically smallest). */
export function pickRefreshOwner(claimTabIds: string[]): string {
  if (claimTabIds.length === 0) return getAuthRefreshTabId();
  return [...claimTabIds].sort(compareTabIds)[0]!;
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
  if (!ch) {
    const pair = await executeRefresh();
    if (pair) {
      blockedRefreshTokens.delete(pair.refreshToken);
      ignorePeerResults = false;
      lastGoodResult = { ...pair, at: Date.now() };
    }
    return pair;
  }

  const startEpoch = coordinationEpoch;

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
    // Session replaced while waiting — do not continue with prior-account state.
    if (coordinationEpoch !== startEpoch) return null;
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

  if (coordinationEpoch !== startEpoch) return null;

  // Leader may have appeared while we claimed.
  if (activeLeader && activeLeader !== getAuthRefreshTabId()) {
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    if (coordinationEpoch !== startEpoch) return null;
  }

  const winner = pickRefreshOwner([...claims]);
  if (winner !== getAuthRefreshTabId()) {
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    if (coordinationEpoch !== startEpoch) return null;
    return null;
  }

  activeLeader = getAuthRefreshTabId();
  try {
    ch.postMessage({ v: 1, type: 'leader', tabId: getAuthRefreshTabId() } satisfies AuthRefreshBcMessage);
  } catch {
    // Continue — we still own locally.
  }
  // Brief settle so a smaller-id leader can steal before we POST.
  await sleep(30);
  if (coordinationEpoch !== startEpoch) return null;
  if (activeLeader && activeLeader !== getAuthRefreshTabId()) {
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    if (coordinationEpoch !== startEpoch) return null;
    return null;
  }

  try {
    const pair = await executeRefresh();
    try {
      if (pair) {
        blockedRefreshTokens.delete(pair.refreshToken);
        ignorePeerResults = false;
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
  coordinationEpoch = 0;
  blockedRefreshTokens = new Set();
  ignorePeerResults = false;
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
