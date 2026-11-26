/**
 * Cross-tab refresh ownership when Web Locks are unavailable (e.g. plain HTTP LAN).
 *
 * BroadcastChannel is same-origin only and is **not atomic** — it does not order
 * messages and gives no bound on delivery latency. An election decided purely
 * from BroadcastChannel messages therefore cannot tell "no peer exists" apart
 * from "a peer's message is still in flight": two tabs can both conclude they
 * own the refresh and POST the *same* refresh token. The server then sees a
 * genuine replay and revokes the whole token family, ending the session.
 *
 * The election is therefore **presence-gated and fenced**:
 *
 *   1. Presence — every tab publishes a heartbeat readable synchronously from
 *      localStorage (see `auth-refresh-presence.ts`). The set of live peers is
 *      therefore complete at decision time instead of depending on message
 *      delivery. Presence is advisory only: it is never used as a lease and
 *      localStorage offers no atomicity.
 *   2. Ownership — the smallest live tab id owns. The set is complete, so the
 *      tie-break is deterministic rather than timing-dependent.
 *   3. Fence — immediately before the network call the winner re-reads presence
 *      and re-checks peer announcements. If a smaller live tab exists it
 *      defers, so a tab that started late learns that it lost instead of racing.
 *
 * It does not replace server-side replay detection, which remains the last
 * line of defence for a genuine consumed-token replay.
 */

import {
  clearPresence,
  publishPresence,
  readParticipatingPeers,
  readRoundSuccessor,
  resetPresenceForTests,
} from './auth-refresh-presence.js';

export const AUTH_REFRESH_CHANNEL = 'ts6-auth-refresh';
export const CLAIM_WINDOW_MS = 80;
export const RESULT_WAIT_MS = 16_000;

/**
 * Settle before the final fence, immediately before the network call.
 *
 * It gives a peer that is only just starting its refresh time to publish its
 * participation record, so the last check before the POST sees it. It is
 * short on purpose: the follower's wait for the leader's result is the real
 * bound, so this must not add noticeable latency.
 */
export const FINAL_FENCE_SETTLE_MS = 40;

/**
 * Identifier for the current refresh round.
 *
 * A round groups the tabs that are concurrently asking for a refresh. Only
 * tabs in the same round coordinate with each other, and only tabs in the
 * same round may own the refresh. A tab that is merely open — alive but not
 * asking for a refresh — is never part of a round and can therefore never
 * block an active tab from refreshing.
 *
 * The round id is derived from the *presented refresh token* so that all tabs
 * competing for the same credential join the same round, while a tab working
 * on a different (e.g. newer) credential does not.
 */
export function refreshRoundId(refreshToken: string | null | undefined): string {
  // Not a secret: the round id is compared, never used to grant access, and
  // it never leaves the browser. A short digest avoids putting the token
  // itself into localStorage.
  let hash = 2166136261;
  const value = refreshToken ?? '';
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `r${(hash >>> 0).toString(36)}`;
}

/**
 * Heartbeat interval for the presence beacon.
 *
 * Must be comfortably smaller than `PRESENCE_STALE_MS` so a live tab is never
 * mistaken for a dead one, and small enough that a peer that appears is seen
 * quickly. 1 s against a 5 s staleness bound leaves room for four missed
 * heartbeats before a tab is considered gone.
 */
export const PRESENCE_HEARTBEAT_MS = 1_000;

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
  | { v: 1; type: 'logout'; tabId: string; authRev?: number };

export type TokenPair = { accessToken: string; refreshToken: string };

let tabIdMemo: string | null = null;
let channel: BroadcastChannel | null | undefined;
let activeLeader: string | null = null;
let lastGoodResult: (TokenPair & { at: number }) | null = null;
let resultWaiters: Array<(msg: AuthRefreshBcMessage & { type: 'result' }) => void> = [];
/** Return false to ignore a peer logout (e.g. origin authRev does not beat ours). */
let peerLogoutHandler: ((originAuthRev: number | undefined) => boolean) | null = null;
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

/**
 * Presence heartbeat.
 *
 * Keeps this tab's presence record fresh so peers can see it, and refreshes
 * the local view of other tabs. The interval is cleared when the tab is
 * suspended or goes away; a peer whose heartbeat goes stale is treated as
 * gone.
 *
 * Lifecycle:
 *   - `pagehide` (tab hidden, frozen or closed) stops the heartbeat and drops
 *     this tab's presence record, so a suspended tab does not keep blocking
 *     other tabs.
 *   - `pageshow` (tab restored from BFCache or resumed) restarts the
 *     heartbeat, so a returning tab becomes visible again.
 *   - `visibilitychange` -> visible also restarts it, covering browsers that
 *     resume a frozen page without firing `pageshow`.
 */
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let presenceLifecycleBound = false;

/** Whether this tab is currently participating in a refresh round. */
let presenceRefreshing = false;
/** The refresh round this tab participates in, if any. */
let presenceRoundId: string | null = null;
/** The successor token this tab minted for the round, if any. */
let presenceSuccessor: string | null = null;
/**
 * A successor published by a peer for the current round, waiting to be
 * applied by the caller (which owns the auth store).
 */
let pendingAdoptedSuccessor: string | null = null;

/**
 * Take the successor token a peer published for the current round, if any.
 *
 * The caller applies it through the normal adoption path and then refreshes
 * the access token from it.
 */
export function takeAdoptedSuccessor(): string | null {
  const successor = pendingAdoptedSuccessor;
  pendingAdoptedSuccessor = null;
  return successor;
}

/**
 * The successor token a peer published for the round that owns `refreshToken`.
 *
 * The caller must check this immediately before presenting a refresh token:
 * the persisted blob can still hold the now-consumed token while the
 * winner's successor is already known. Presenting the consumed token is a
 * genuine replay, so the published successor must win.
 */
export function readPublishedSuccessor(refreshToken: string | null | undefined): string | null {
  if (!refreshToken) return null;
  const roundId = refreshRoundId(refreshToken);
  return readRoundSuccessor(getAuthRefreshTabId(), roundId);
}

function startPresenceHeartbeat(): void {
  if (presenceTimer !== null) return;
  if (typeof window === 'undefined') return;
  const tabId = getAuthRefreshTabId();
  publishPresence(tabId, Date.now(), presenceRefreshing, presenceRoundId, presenceSuccessor);
  presenceTimer = setInterval(() => {
    publishPresence(tabId, Date.now(), presenceRefreshing, presenceRoundId, presenceSuccessor);
  }, PRESENCE_HEARTBEAT_MS);
  // Do not keep a Node unit-test process alive.
  (presenceTimer as unknown as { unref?: () => void }).unref?.();
  bindPresenceLifecycle();
}

/**
 * Bind the page lifecycle handlers once.
 *
 * A minimal `window` stub (Node unit tests) may not implement the DOM API,
 * so every call is guarded.
 */
function bindPresenceLifecycle(): void {
  if (presenceLifecycleBound) return;
  if (typeof window === 'undefined') return;
  if (typeof window.addEventListener !== 'function') return;
  presenceLifecycleBound = true;

  window.addEventListener('pagehide', () => {
    // The tab is being suspended, frozen or closed: stop publishing so this
    // tab stops being treated as a live participant.
    stopPresenceHeartbeat();
    clearPresence(getAuthRefreshTabId());
  });

  window.addEventListener('pageshow', () => {
    // Restored from BFCache or resumed: publish again so peers see us.
    startPresenceHeartbeat();
  });

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') startPresenceHeartbeat();
    });
  }
}

function stopPresenceHeartbeat(): void {
  if (presenceTimer !== null) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
}

/**
 * Mark this tab as participating (or not) in a refresh round.
 *
 * A tab that is not participating is alive but idle: it must never be able to
 * own a refresh, because that would stop an active tab from refreshing.
 */
function setPresenceParticipation(
  refreshing: boolean,
  roundId: string | null,
  successor: string | null = null,
): void {
  presenceRefreshing = refreshing;
  presenceRoundId = roundId;
  presenceSuccessor = successor;
  if (presenceTimer !== null) {
    publishPresence(getAuthRefreshTabId(), Date.now(), refreshing, roundId, successor);
  }
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

/**
 * After a successful *local* refresh that still belongs to `startEpoch`,
 * re-enable same-account peer adoption. Does not clear blocked prior-session
 * tokens. No-op when the session was replaced mid-flight.
 */
export function markLocalRefreshSuccess(pair: TokenPair, startEpoch: number): boolean {
  if (!pair.accessToken || !pair.refreshToken) return false;
  if (coordinationEpoch !== startEpoch) return false;
  // Only unstick the new live token if it was previously blocked; keep others.
  blockedRefreshTokens.delete(pair.refreshToken);
  ignorePeerResults = false;
  lastGoodResult = { ...pair, at: Date.now() };
  return true;
}

function ensureListener(): void {
  if (listenerInstalled) return;
  const ch = getChannel();
  if (!ch) return;
  listenerInstalled = true;
  // Start the presence beacon as soon as the tab participates in coordination.
  startPresenceHeartbeat();
  ch.addEventListener('message', (ev: MessageEvent) => {
    if (!isMessage(ev.data)) return;
    const msg = ev.data;
    if (msg.type === 'leader') {
      // A peer announced leadership. Ownership is decided by the smallest live
      // tab id, so:
      //   - a peer with a SMALLER id outranks us  -> we must stand down;
      //   - a peer with a LARGER id does not outrank us, but we still record it
      //     so the fence can see that another leader exists.
      // The previous code left `activeLeader` untouched for a larger-id peer,
      // which is correct for the tie-break but meant a tab could not tell that
      // a peer had claimed leadership at all.
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
      const applied = peerLogoutHandler?.(msg.authRev) ?? true;
      if (applied) clearCoordinationState();
    }
  });
}

export function setAuthRefreshPeerLogoutHandler(
  handler: ((originAuthRev: number | undefined) => boolean) | null,
): void {
  peerLogoutHandler = handler;
  ensureListener();
}

export function broadcastAuthLogout(authRev: number): void {
  clearCoordinationState();
  if (suppressLogoutBroadcast) return;
  const ch = getChannel();
  if (!ch) return;
  ensureListener();
  try {
    ch.postMessage({
      v: 1,
      type: 'logout',
      tabId: getAuthRefreshTabId(),
      authRev,
    } satisfies AuthRefreshBcMessage);
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
 *
 * `refreshToken` identifies the credential this round is refreshing. Tabs
 * that ask for a refresh of the SAME credential join the same round and
 * coordinate; a tab that is merely open — alive but not asking for a refresh
 * — is not in any round and can therefore never own or block a refresh.
 *
 * See the module header for why this is presence-gated and fenced rather than
 * a pure BroadcastChannel handshake.
 */
export async function coordinateRefreshOwnership(
  executeRefresh: () => Promise<TokenPair | null>,
  refreshToken?: string | null,
): Promise<TokenPair | null> {
  const ch = getChannel();
  ensureListener();
  if (!ch) {
    const startEpoch = coordinationEpoch;
    const pair = await executeRefresh();
    if (pair) markLocalRefreshSuccess(pair, startEpoch);
    return pair;
  }

  const startEpoch = coordinationEpoch;
  const tabId = getAuthRefreshTabId();

  if (lastGoodResult && Date.now() - lastGoodResult.at < 2_000) {
    return {
      accessToken: lastGoodResult.accessToken,
      refreshToken: lastGoodResult.refreshToken,
    };
  }

  // Peer already refreshing — wait instead of starting a competing POST.
  if (activeLeader && activeLeader !== tabId) {
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    // Session replaced while waiting — do not continue with prior-account state.
    if (coordinationEpoch !== startEpoch) return null;
  }

  // The refresh round groups the tabs that are concurrently asking for a
  // refresh of the SAME credential. Only tabs in this round may own the
  // refresh, so an idle tab (open, but not asking for a refresh) can never
  // block an active tab.
  const roundId = refreshRoundId(refreshToken ?? null);
  setPresenceParticipation(true, roundId);

  try {
    return await runRefreshRound(ch, tabId, roundId, startEpoch, executeRefresh);
  } finally {
    // This tab is no longer taking part in a refresh round. It stays alive
    // (peers may still see it), but it must not be able to own a later
    // refresh, and it must not keep a withdrawn participant alive.
    setPresenceParticipation(false, null);
  }
}

async function runRefreshRound(
  ch: BroadcastChannel,
  tabId: string,
  roundId: string,
  startEpoch: number,
  executeRefresh: () => Promise<TokenPair | null>,
): Promise<TokenPair | null> {
  const claims = new Set<string>([tabId]);
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
      // Announce ourselves AND publish presence. The claim message lets a peer
      // learn about us quickly; the presence record lets every tab learn about
      // us synchronously, so a delayed claim delivery cannot hide us.
      try {
        ch.postMessage({ v: 1, type: 'claim', tabId } satisfies AuthRefreshBcMessage);
      } catch {
        // Channel closed — fall through to local refresh.
      }
      publishPresence(tabId, Date.now(), true, roundId);
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
  if (activeLeader && activeLeader !== tabId) {
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    if (coordinationEpoch !== startEpoch) return null;
  }

  // --- Presence-gated ownership decision ---------------------------------
  // Only tabs that are PARTICIPATING in this round may own the refresh.
  // The participating set is read synchronously, so it is complete even if a
  // peer's `claim` message is still in flight.
  //
  // `claim` messages are NOT used to widen the candidate set: a claim may
  // come from a tab that is alive but idle (it is not asking for a refresh),
  // and honouring such a claim would let an idle tab win ownership and stop
  // the refresh entirely.
  const participants = new Set<string>(readParticipatingPeers(tabId, roundId));
  participants.add(tabId);
  const winner = pickRefreshOwner([...participants]);
  if (winner !== tabId) {
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    if (coordinationEpoch !== startEpoch) return null;
    return null;
  }

  activeLeader = tabId;
  try {
    ch.postMessage({ v: 1, type: 'leader', tabId } satisfies AuthRefreshBcMessage);
  } catch {
    // Continue — we still own locally.
  }
  // Brief settle so a smaller-id leader can steal before we POST.
  await sleep(30);
  if (coordinationEpoch !== startEpoch) return null;
  if (activeLeader && activeLeader !== tabId) {
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    if (coordinationEpoch !== startEpoch) return null;
    return null;
  }

  // --- Fence ---------------------------------------------------------------
  // The settle window above only covers the case where a peer's `leader`
  // message arrived in time. A peer whose message is still delayed would not
  // have been seen yet, so re-read the *synchronously readable* participating
  // set and refuse to POST if a smaller participating tab exists. This is the
  // check that makes a delayed announcement safe.
  //
  // Only participating tabs are considered: an idle tab must never be able to
  // fence off an active tab.
  const fencePeers = readParticipatingPeers(tabId, roundId);
  const smallerLivePeer = fencePeers
    .filter((peer) => compareTabIds(peer, tabId) < 0)
    .sort(compareTabIds)[0];
  if (smallerLivePeer) {
    // A smaller participating tab owns the refresh. Stand down and wait for
    // its result.
    activeLeader = null;
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    if (coordinationEpoch !== startEpoch) return null;
    return null;
  }

  // --- Final fence ---------------------------------------------------------
  // The check above runs after the claim window; a peer that starts its own
  // refresh slightly later may only publish its participation afterwards.
  // Re-check as late as possible — immediately before the network call — so
  // that a late participant is seen before this tab commits to a POST.
  //
  // The short settle gives a peer that is *just* starting the time to publish
  // its participation record. It is deliberately short: the wait for the
  // leader's result below is the real bound, so this must not add latency.
  await sleep(FINAL_FENCE_SETTLE_MS);
  if (coordinationEpoch !== startEpoch) return null;

  // If a peer has already rotated for this round and published its successor,
  // adopt it. Presenting the consumed token again would be a genuine replay:
  // the server rejects it and may revoke the whole family.
  //
  // The successor is returned through the result channel so the caller can
  // apply it with the normal adoption path; this module must not touch the
  // auth store directly.
  const publishedSuccessor = readRoundSuccessor(tabId, roundId);
  if (publishedSuccessor) {
    activeLeader = null;
    pendingAdoptedSuccessor = publishedSuccessor;
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    if (coordinationEpoch !== startEpoch) return null;
    // No peer result arrived, but the published successor is authoritative:
    // the peer that minted it already rotated.
    return { accessToken: '', refreshToken: publishedSuccessor };
  }

  const finalFencePeers = readParticipatingPeers(tabId, roundId);
  const finalSmallerPeer = finalFencePeers
    .filter((peer) => compareTabIds(peer, tabId) < 0)
    .sort(compareTabIds)[0];
  if (finalSmallerPeer) {
    activeLeader = null;
    const waited = await waitForResult(RESULT_WAIT_MS);
    if (waited) return waited;
    if (coordinationEpoch !== startEpoch) return null;
    return null;
  }

  try {
    const pair = await executeRefresh();
    try {
      if (pair) {
        // Publish the successor token for this round. A peer that lost the
        // election can then adopt it instead of presenting the now-consumed
        // token again — presenting it again is a genuine replay, which the
        // server rejects and which may revoke the whole family.
        setPresenceParticipation(true, roundId, pair.refreshToken);
        markLocalRefreshSuccess(pair, startEpoch);
        ch.postMessage({
          v: 1,
          type: 'result',
          tabId,
          ok: true,
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
        } satisfies AuthRefreshBcMessage);
      } else if (!(lastGoodResult && Date.now() - lastGoodResult.at < RESULT_WAIT_MS)) {
        ch.postMessage({
          v: 1,
          type: 'result',
          tabId,
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
    if (activeLeader === tabId) activeLeader = null;
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
  stopPresenceHeartbeat();
  resetPresenceForTests();
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
